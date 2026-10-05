import { describe, expect, it } from "vitest";
import { describeStep, newRecording, RecordingBuilder } from "../src/recorder/builder.js";
import { detectAccountVars } from "../src/recorder/accounts.js";
import { generateValues } from "../src/recorder/generators.js";
import { rebase, recordingToWorkflow, resumePoint, variablesUsed } from "../src/recorder/replay.js";
import type { PageEvent } from "../src/recorder/types.js";

function builderAt(start = 0) {
  let t = start;
  const clock = { advance: (ms: number) => (t += ms) };
  const b = new RecordingBuilder(newRecording("teste", "https://site.example/signup"), () => t);
  return { b, clock };
}

const input = (selector: string, value: string, extra: Partial<PageEvent> = {}): PageEvent =>
  ({ kind: "input", selector, value, inputType: "text", field: selector.replace(/\W/g, ""), ...extra }) as PageEvent;

describe("RecordingBuilder", () => {
  it("junta a digitação no mesmo campo num único fill com variável", () => {
    const { b } = builderAt();
    for (const v of ["j", "jo", "joao@x.com"]) b.addPageEvent(input("#email", v));
    expect(b.steps).toEqual([{ type: "fill", selector: "#email", value: "{{email}}" }]);
    expect(b.recording.variables).toEqual({ email: "joao@x.com" });
  });

  it("não salva senhas e unifica 'confirmar senha' com o mesmo valor", () => {
    const { b } = builderAt();
    b.addPageEvent(input("#password", "segredo123", { inputType: "password", field: "password" } as never));
    b.addPageEvent(input("#confirmPassword", "segredo123", { inputType: "password", field: "confirmPassword" } as never));
    const snap = b.snapshot();
    expect(snap.variables).toEqual({ password: null });
    expect(snap.steps.map((s) => ("value" in s ? s.value : ""))).toEqual(["{{password}}", "{{password}}"]);
    expect(JSON.stringify(snap)).not.toContain("segredo123");
  });

  it("navegação logo após clique vira waitForUrl; sem ação vira goto; redirect é colapsado", () => {
    const { b, clock } = builderAt();
    b.addNavigation("https://site.example/signup");
    clock.advance(5_000);
    b.addPageEvent({ kind: "click", alt: false, selector: "button:has-text(\"Entrar\")" });
    clock.advance(200);
    b.addNavigation("https://site.example/login");
    clock.advance(300);
    b.addNavigation("https://site.example/home"); // redirect
    clock.advance(10_000);
    b.addNavigation("https://site.example/perfil"); // digitada na barra
    expect(b.steps.map((s) => s.type)).toEqual(["goto", "click", "waitForUrl", "goto"]);
    expect(b.steps[2]).toEqual({ type: "waitForUrl", url: "https://site.example/home" });
  });

  it("Alt+clique vira ponto de verificação e checkbox repetido é colapsado", () => {
    const { b } = builderAt();
    b.addPageEvent({ kind: "check", checked: true, selector: "#terms" });
    b.addPageEvent({ kind: "check", checked: false, selector: "#terms" });
    b.addPageEvent({ kind: "click", alt: true, selector: "#ok", hint: "Conta criada" });
    expect(b.steps).toEqual([
      { type: "check", checked: false, selector: "#terms" },
      { type: "waitVisible", selector: "#ok", hint: "Conta criada" },
    ]);
    expect(describeStep(b.steps[1])).toBe('verificar que "Conta criada" aparece');
  });

  it("dá nomes distintos a campos diferentes com o mesmo nome", () => {
    const { b } = builderAt();
    b.addPageEvent(input("#a", "1", { field: "nome" } as never));
    b.addPageEvent(input("#b", "2", { field: "nome" } as never));
    expect(b.recording.variables).toEqual({ nome: "1", nome_2: "2" });
  });
});

describe("recordingToWorkflow", () => {
  const rec = () => {
    const r = newRecording("fluxo", "https://site.example/signup");
    r.variables = { email: "a@b.com", password: null };
    r.steps = [
      { type: "goto", url: "https://site.example/signup" },
      { type: "fill", selector: "#email", value: "{{email}}" },
      { type: "fill", selector: "#password", value: "{{password}}" },
      { type: "click", selector: "#submit" },
    ];
    return r;
  };

  it("exige variáveis sem valor salvo e aceita --set", () => {
    const wf = recordingToWorkflow(rec());
    expect(() => wf.buildInput({}, wf.defaults)).toThrow(/--set password=/);
    expect(wf.buildInput({ password: "x" }, wf.defaults)).toEqual({ email: "a@b.com", password: "x" });
  });

  it("começa do passo pedido e só exige as variáveis restantes", () => {
    const wf = recordingToWorkflow(rec(), { from: 3, resumeUrl: "https://site.example/signup" });
    expect(wf.steps.map((s) => s.name)).toEqual(["retomar em https://site.example/signup", "#4 clicar #submit"]);
    expect(() => wf.buildInput({}, wf.defaults)).not.toThrow();
    expect(() => recordingToWorkflow(rec(), { from: 9 })).toThrow(/fora do intervalo/);
  });

  it("usa a origem da gravação como baseUrl e reescreve URLs com --base-url", () => {
    expect(recordingToWorkflow(rec()).defaults.baseUrl).toBe("https://site.example");
    expect(rebase("https://site.example/a?x=1", "https://site.example", "http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000/a?x=1");
    expect(rebase("https://outro.example/a", "https://site.example", "http://127.0.0.1:4000")).toBe("https://outro.example/a");
    expect(variablesUsed(rec().steps)).toEqual(["email", "password"]);
  });
});

describe("resumePoint", () => {
  const steps = [
    { type: "goto", url: "https://s.example/a" },
    { type: "click", selector: "#login" },
    { type: "waitForUrl", url: "https://s.example/b" },
    { type: "fill", selector: "#x", value: "1" },
    { type: "click", selector: "#next" },
    { type: "waitForUrl", url: "https://s.example/c" },
  ] as const;

  it("volta para logo depois da última navegação", () => {
    expect(resumePoint([...steps], 4)).toEqual({ nextStep: 3, url: "https://s.example/b" });
  });
  it("se a própria navegação falhou, refaz a ação que a causaria", () => {
    expect(resumePoint([...steps], 5)).toEqual({ nextStep: 3, url: "https://s.example/b" });
    expect(resumePoint([...steps], 2)).toEqual({ nextStep: 1, url: "https://s.example/a" });
  });
  it("sem navegação anterior, recomeça do zero", () => {
    expect(resumePoint([...steps], 0)).toEqual({ nextStep: 0 });
  });
});

describe("valores aleatórios (Alt+G)", () => {
  it("grava {{gen.*}}, ignora o eco do preenchimento e limpa a variável trocada", () => {
    const gen = generateValues();
    const b = new RecordingBuilder(newRecording("t", "https://s.example/"), Date.now, gen);
    b.addPageEvent(input("#nome", "Maria", { field: "nome" } as never));
    b.addPageEvent({ kind: "generate", gen: "fullName", inputType: "text", selector: "#nome" });
    b.addPageEvent(input("#nome", gen["gen.fullName"])); // eco do fill automático
    b.addPageEvent({ kind: "generate", gen: "password", inputType: "password", selector: "#senha" });
    b.addPageEvent({ kind: "generate", gen: "naoExiste", inputType: "text", selector: "#x" });
    const snap = b.snapshot();
    expect(snap.steps).toEqual([
      { type: "fill", selector: "#nome", value: "{{gen.fullName}}" },
      { type: "fill", selector: "#senha", value: "{{gen.password}}" },
    ]);
    expect(snap.variables).toEqual({});
  });

  it("se o usuário editar o campo depois, vira variável comum", () => {
    const gen = generateValues();
    const b = new RecordingBuilder(newRecording("t", "https://s.example/"), Date.now, gen);
    b.addPageEvent({ kind: "generate", gen: "email", inputType: "email", selector: "#email" });
    b.addPageEvent(input("#email", gen["gen.email"]));
    b.addPageEvent(input("#email", "fixo@x.com", { field: "email" } as never));
    expect(b.snapshot().steps).toEqual([{ type: "fill", selector: "#email", value: "{{email}}" }]);
  });

  it("gera um conjunto novo e coerente a cada execução; --set fixa um valor", () => {
    const r = newRecording("t", "https://s.example/");
    r.steps = [
      { type: "fill", selector: "#n", value: "{{gen.fullName}}" },
      { type: "fill", selector: "#e", value: "{{gen.email}}" },
    ];
    const wf = recordingToWorkflow(r);
    const a = wf.buildInput({}, wf.defaults);
    const b = wf.buildInput({}, wf.defaults);
    expect(a["gen.email"]).not.toBe(b["gen.email"]);
    expect(a["gen.email"]).toMatch(/@example\.test$/);
    const [first] = a["gen.fullName"].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(" ");
    expect(a["gen.email"].startsWith(first + ".")).toBe(true);
    expect(wf.buildInput({ "gen.fullName": "Fixo Silva" } as never, wf.defaults)["gen.fullName"]).toBe("Fixo Silva");
  });
});

describe("accountFields e Alt+M", () => {
  it("marca o campo já preenchido como identificador da conta", () => {
    const { b } = builderAt();
    b.addPageEvent(input("#email", "maria@x.com", { field: "email" } as never));
    b.addPageEvent({ kind: "markAccount", role: "identifier", selector: "#email" } as never);
    b.addPageEvent(input("#pw", "segredo", { inputType: "password", field: "password" } as never));
    b.addPageEvent({ kind: "markAccount", role: "password", selector: "#pw" } as never);
    expect(b.recording.accountFields).toEqual({ identifier: "email", password: "password" });
  });

  it("marca pendente quando Alt+M vem ANTES do preenchimento", () => {
    const { b } = builderAt();
    b.addPageEvent({ kind: "markAccount", role: "identifier", selector: "#email" } as never);
    b.addPageEvent(input("#email", "ana@x.com", { field: "email" } as never));
    expect(b.recording.accountFields).toEqual({ identifier: "email" });
  });

  it("Alt+M + Alt+G funciona junto", () => {
    const gen = generateValues();
    const b = new RecordingBuilder(newRecording("t", "https://s.example/"), Date.now, gen);
    b.addPageEvent({ kind: "markAccount", role: "identifier", selector: "#e" } as never);
    b.addPageEvent({ kind: "generate", gen: "email", inputType: "email", selector: "#e" } as never);
    b.addPageEvent(input("#e", gen["gen.email"])); // eco
    expect(b.recording.accountFields).toEqual({ identifier: "gen.email" });
  });
});

describe("detectAccountVars", () => {
  it("usa accountFields explícito", () => {
    const r = newRecording("t", "https://s.example/");
    r.accountFields = { identifier: "login", password: "pw" };
    r.steps = [{ type: "fill", selector: "#a", value: "{{login}}" }, { type: "fill", selector: "#b", value: "{{pw}}" }];
    expect(detectAccountVars(r)).toEqual({ identifier: "login", password: "pw" });
  });

  it("detecta gen.email / gen.password", () => {
    const r = newRecording("t", "https://s.example/");
    r.steps = [
      { type: "fill", selector: "#e", value: "{{gen.email}}" },
      { type: "fill", selector: "#p", value: "{{gen.password}}" },
    ];
    expect(detectAccountVars(r)).toEqual({ identifier: "gen.email", password: "gen.password" });
  });

  it("detecta nomes comuns de variáveis", () => {
    const r = newRecording("t", "https://s.example/");
    r.steps = [
      { type: "fill", selector: "#e", value: "{{email}}" },
      { type: "fill", selector: "#p", value: "{{password}}" },
    ];
    expect(detectAccountVars(r)).toEqual({ identifier: "email", password: "password" });
  });
});

describe("callApi step", () => {
  it("é descrito corretamente", () => {
    expect(describeStep({ type: "callApi", url: "https://api.example/check", method: "POST" }))
      .toBe("chamar API POST https://api.example/check");
  });
});

describe("readValue / Alt+S", () => {
  it("captureValue vira passo readValue", () => {
    const { b } = builderAt();
    b.addPageEvent({ kind: "captureValue", saveAs: "telefone", value: "+55 31 99999-0000", selector: "#phone", hint: "Telefone" } as never);
    expect(b.steps).toEqual([{ type: "readValue", saveAs: "telefone", selector: "#phone", hint: "Telefone" }]);
    expect(describeStep(b.steps[0])).toBe("ler \"Telefone\" → {{read.telefone}}");
  });

  it("read.* é aceito em callApi e fill sem precisar de --set", () => {
    const r = newRecording("t", "https://s.example/");
    r.steps = [
      { type: "readValue", saveAs: "code", selector: "#code" },
      { type: "callApi", url: "https://api.example/verify?code={{read.code}}" },
    ];
    const wf = recordingToWorkflow(r);
    expect(() => wf.buildInput({}, wf.defaults)).not.toThrow();
  });
});

describe("callApi extract", () => {
  it("api.* é aceito em fill sem precisar de --set", () => {
    const r = newRecording("t", "https://s.example/");
    r.steps = [
      { type: "readValue", saveAs: "phone", selector: "#tel" },
      { type: "callApi", url: "https://api.example/sms", method: "POST", body: "{\"phone\": \"{{read.phone}}\"}", extract: { code: "code" } },
      { type: "fill", selector: "#code", value: "{{api.code}}" },
    ];
    const wf = recordingToWorkflow(r);
    expect(() => wf.buildInput({}, wf.defaults)).not.toThrow();
  });
});
