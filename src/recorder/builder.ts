/**
 * Transforma o fluxo bruto de eventos da página em passos limpos:
 *  - digitação no mesmo campo vira UM `fill` com o valor final;
 *  - cada campo de texto vira uma variável `{{nome}}` (senhas não são salvas);
 *  - navegações viram `goto` (digitadas/abertas) ou `waitForUrl` (causadas
 *    pelo passo anterior); redirecionamentos em sequência são colapsados.
 *
 * Não depende do navegador, então é testável em unidade.
 */

import { GEN_PREFIX, generateValues, isGeneratorKind, type GeneratedValues } from "./generators.js";
import type { PageEvent, RecordedStep, Recording, Target } from "./types.js";

/** Janela (ms) em que uma navegação é considerada consequência da última ação. */
const ACTION_WINDOW_MS = 4_000;

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "campo";

const target = (e: Target): Target => ({
  selector: e.selector,
  ...(e.fallbacks?.length ? { fallbacks: e.fallbacks } : {}),
  ...(e.hint ? { hint: e.hint } : {}),
});

export class RecordingBuilder {
  readonly recording: Recording;
  private lastActionAt: number | undefined;
  private lastNavAt = 0;
  /** seletor → nome da variável já atribuída a esse campo */
  private fieldVars = new Map<string, string>();
  /** variável de senha → valor digitado (só em memória, nunca salvo) */
  private passwordValues = new Map<string, string>();

  /**
   * Valores aleatórios desta sessão de gravação (os campos marcados com Alt+G
   * são preenchidos com eles; no replay cada execução gera os seus).
   */
  readonly generated: GeneratedValues;
  /** seletor → valor gerado que foi colocado no campo (para ignorar o "eco"). */
  private generatedIn = new Map<string, string>();
  /** seletor → role pendente de um Alt+M feito ANTES do preenchimento. */
  private pendingAccountMark = new Map<string, "identifier" | "password">();

  constructor(
    recording: Recording,
    private readonly now: () => number = Date.now,
    generated: GeneratedValues = generateValues(),
  ) {
    this.recording = recording;
    this.generated = generated;
    // Ao continuar uma gravação, reaproveita os nomes de variáveis existentes.
    for (const step of recording.steps) {
      if (step.type === "fill" || step.type === "select") {
        const m = /^\{\{(\w+)\}\}$/.exec(step.value);
        if (m) this.fieldVars.set(step.selector, m[1]);
      }
    }
  }

  get steps(): RecordedStep[] {
    return this.recording.steps;
  }

  private last(): RecordedStep | undefined {
    return this.steps[this.steps.length - 1];
  }

  private push(step: RecordedStep): void {
    this.steps.push(step);
    this.recording.updatedAt = new Date(this.now()).toISOString();
  }

  private varFor(selector: string, field: string): string {
    const existing = this.fieldVars.get(selector);
    if (existing) return existing;
    let name = slug(field);
    for (let i = 2; name in this.recording.variables; i++) {
      name = `${slug(field)}_${i}`;
    }
    this.fieldVars.set(selector, name);
    return name;
  }

  /** Registra um evento vindo do script injetado. */
  addPageEvent(e: PageEvent, at: number = this.now()): RecordedStep | undefined {
    const t = target(e);
    switch (e.kind) {
      case "click": {
        if (!e.alt) this.lastActionAt = at;
        const step: RecordedStep = e.alt ? { type: "waitVisible", ...t } : { type: "click", ...t };
        this.push(step);
        return step;
      }
      case "captureValue": {
        const step: RecordedStep = { type: "readValue", saveAs: e.saveAs, ...t };
        this.push(step);
        return step;
      }
      case "markAccount": {
        // Marca o campo que JÁ foi preenchido (fill anterior) como parte da conta.
        const prevFill = [...this.steps].reverse().find((s) => s.type === "fill" && s.selector === e.selector);
        if (!prevFill || prevFill.type !== "fill") {
          // Campo ainda não preenchido — registra só a marcação (o fill futuro herda).
          this.pendingAccountMark.set(e.selector, e.role);
          return undefined;
        }
        const varMatch = /^\{\{([\w.]+)\}\}$/.exec(prevFill.value);
        const varName = varMatch?.[1] ?? e.selector;
        this.recording.accountFields ??= {};
        this.recording.accountFields[e.role] = varName;
        return undefined;
      }
      case "generate": {
        if (!isGeneratorKind(e.gen)) return undefined;
        const name = `${GEN_PREFIX}${e.gen}` as keyof GeneratedValues;
        this.generatedIn.set(e.selector, this.generated[name]);
        const value = `{{${name}}}`;
        const prev = this.last();
        if (prev?.type === "fill" && prev.selector === e.selector) {
          prev.value = value; // trocou o que tinha digitado por aleatório
          return prev;
        }
        const step: RecordedStep = { type: "fill", value, ...t };
        this.push(step);
        // Alt+G num campo com Alt+M pendente
        const genPending = this.pendingAccountMark.get(e.selector);
        if (genPending) {
          const genVarMatch = /^\{\{([\w.]+)\}\}$/.exec(value);
          if (genVarMatch) {
            this.recording.accountFields ??= {};
            this.recording.accountFields[genPending] = genVarMatch[1];
            this.pendingAccountMark.delete(e.selector);
          }
        }
        return step;
      }
      case "input": {
        // Eco do preenchimento automático de um campo marcado com Alt+G.
        if (this.generatedIn.get(e.selector) === e.value) return undefined;
        this.generatedIn.delete(e.selector); // o usuário editou: vira variável comum
        // Alt+M pendente: marca a variável deste campo
        const pendingRole = this.pendingAccountMark.get(e.selector);
        let value: string;
        const name = this.varFor(e.selector, e.field);
        if (e.inputType === "password") {
          // Senhas nunca vão para o arquivo: viram variável sem valor.
          this.passwordValues.set(name, e.value);
          this.recording.variables[name] = null;
        } else {
          this.recording.variables[name] = e.value;
        }
        value = `{{${name}}}`;
        const prev = this.last();
        if (prev?.type === "fill" && prev.selector === e.selector) {
          prev.value = value; // digitação contínua no mesmo campo
          if (pendingRole) {
            const vm = /^\{\{([\w.]+)\}\}$/.exec(value);
            if (vm) {
              this.recording.accountFields ??= {};
              this.recording.accountFields[pendingRole] = vm[1];
              this.pendingAccountMark.delete(e.selector);
            }
          }
          return prev;
        }
        const step: RecordedStep = { type: "fill", value, ...t };
        this.push(step);
        if (pendingRole) {
          const vm = /^\{\{([\w.]+)\}\}$/.exec(value);
          if (vm) {
            this.recording.accountFields ??= {};
            this.recording.accountFields[pendingRole] = vm[1];
            this.pendingAccountMark.delete(e.selector);
          }
        }
        return step;
      }
      case "select": {
        this.lastActionAt = at;
        const prev = this.last();
        if (prev?.type === "select" && prev.selector === e.selector) {
          prev.value = e.value;
          return prev;
        }
        const step: RecordedStep = { type: "select", value: e.value, ...t };
        this.push(step);
        return step;
      }
      case "check": {
        const prev = this.last();
        if (prev?.type === "check" && prev.selector === e.selector) {
          prev.checked = e.checked;
          return prev;
        }
        const step: RecordedStep = { type: "check", checked: e.checked, ...t };
        this.push(step);
        return step;
      }
      case "key": {
        this.lastActionAt = at;
        const step: RecordedStep = { type: "press", key: e.key, ...t };
        this.push(step);
        return step;
      }
    }
  }

  /**
   * Cópia pronta para salvar. Campos de senha com o mesmo valor (ex.: "senha"
   * e "confirmar senha") passam a usar uma única variável, então no replay
   * basta `--set password=...`.
   */
  snapshot(): Recording {
    const rec: Recording = structuredClone(this.recording);
    const firstByValue = new Map<string, string>();
    const alias = new Map<string, string>();
    for (const [name, value] of this.passwordValues) {
      const first = firstByValue.get(value);
      if (first) alias.set(name, first);
      else firstByValue.set(value, name);
    }
    for (const step of rec.steps) {
      if (step.type !== "fill") continue;
      const m = /^\{\{(\w+)\}\}$/.exec(step.value);
      if (m && alias.has(m[1])) step.value = `{{${alias.get(m[1])}}}`;
    }
    for (const name of alias.keys()) delete rec.variables[name];
    // Remove variáveis que nenhum passo usa mais (ex.: campo trocado por Alt+G).
    const used = new Set<string>();
    for (const step of rec.steps) {
      if ("value" in step) for (const m of step.value.matchAll(/\{\{([\w.]+)\}\}/g)) used.add(m[1]);
    }
    for (const name of Object.keys(rec.variables)) if (!used.has(name)) delete rec.variables[name];
    return rec;
  }

  /** Registra a navegação do frame principal para `url`. */
  addNavigation(url: string, now: number = this.now()): RecordedStep | undefined {
    if (!/^https?:/i.test(url)) return undefined;
    const prev = this.last();
    const sameUrl = (a: string, b: string) => stripHash(a) === stripHash(b);

    // Redirecionamento logo após outra navegação, sem ação do usuário no meio.
    if (prev && (prev.type === "goto" || prev.type === "waitForUrl") && now - this.lastNavAt < 1_500) {
      this.lastNavAt = now;
      if (prev.type === "waitForUrl") prev.url = url; // espera o destino final
      return undefined;
    }
    if (prev && (prev.type === "goto" || prev.type === "waitForUrl") && sameUrl(prev.url, url)) return undefined;

    this.lastNavAt = now;
    const causedByAction = this.lastActionAt !== undefined && now - this.lastActionAt < ACTION_WINDOW_MS;
    const step: RecordedStep = causedByAction ? { type: "waitForUrl", url } : { type: "goto", url };
    this.lastActionAt = undefined; // uma ação explica no máximo uma navegação
    this.push(step);
    return step;
  }
}

const stripHash = (u: string) => u.split("#")[0];

export function newRecording(name: string, startUrl: string, description?: string): Recording {
  const ts = new Date().toISOString();
  return {
    version: 1,
    name,
    description: description ?? `Gravação em ${new URL(startUrl).host}`,
    startUrl,
    createdAt: ts,
    updatedAt: ts,
    variables: {},
    steps: [],
  };
}

/** Texto curto de um passo, para `show` e logs. */
export function describeStep(step: RecordedStep): string {
  const who = "selector" in step ? (step.hint ? `"${step.hint}"` : step.selector) : "";
  switch (step.type) {
    case "goto":
      return `abrir ${step.url}`;
    case "waitForUrl":
      return `esperar URL ${step.url}`;
    case "click":
      return `clicar ${who}`;
    case "fill":
      return `preencher ${who} ← ${step.value}`;
    case "select":
      return `selecionar ${who} ← ${step.value}`;
    case "check":
      return `${step.checked ? "marcar" : "desmarcar"} ${who}`;
    case "press":
      return `tecla ${step.key} em ${who}`;
    case "waitVisible":
      return `verificar que ${who} aparece`;
    case "readValue":
      return `ler ${who} → {{read.${step.saveAs}}}`;
    case "callApi":
      return `chamar API ${step.method ?? "GET"} ${step.url}`;
  }
}
