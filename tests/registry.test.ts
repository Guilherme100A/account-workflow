import { describe, expect, it } from "vitest";
import { defineWorkflow, WorkflowRegistry } from "../src/core/registry.js";
import type { WorkflowDefinition } from "../src/core/types.js";
import localSignup from "../src/workflows/local-signup.js";

const base = (): WorkflowDefinition => ({
  name: "exemplo",
  description: "workflow de exemplo",
  defaults: { baseUrl: "http://127.0.0.1:1" },
  buildInput: (overrides) => overrides,
  steps: [{ name: "noop", run: () => undefined }],
});

describe("defineWorkflow", () => {
  it("aceita uma definição válida e a congela", () => {
    const wf = defineWorkflow(base());
    expect(wf.name).toBe("exemplo");
    expect(Object.isFrozen(wf)).toBe(true);
  });

  it.each<[string, Partial<WorkflowDefinition>]>([
    ["sem name", { name: "" }],
    ["sem description", { description: "" }],
    ["sem baseUrl", { defaults: { baseUrl: "" } }],
    ["steps vazio", { steps: [] }],
    ["step sem run", { steps: [{ name: "x" } as any] }],
  ])("rejeita definição inválida: %s", (_label, patch) => {
    expect(() => defineWorkflow({ ...base(), ...patch })).toThrow();
  });
});

describe("WorkflowRegistry", () => {
  it("registra e recupera workflows", () => {
    const wf = defineWorkflow(base());
    const reg = new WorkflowRegistry().register(wf);
    expect(reg.get("exemplo")).toBe(wf);
    expect(reg.names()).toEqual(["exemplo"]);
    expect(reg.list()).toEqual([wf]);
  });

  it("rejeita nomes duplicados", () => {
    const reg = new WorkflowRegistry().register(defineWorkflow(base()));
    expect(() => reg.register(defineWorkflow(base()))).toThrow(/duplicado/);
  });

  it("get() de nome inexistente lança", () => {
    const reg = new WorkflowRegistry().register(defineWorkflow(base()));
    expect(() => reg.get("nao-existe")).toThrow(/não encontrado/);
  });
});

describe("local-signup.buildInput", () => {
  const config = localSignup.defaults;

  it("gera input completo com confirmPassword igual a password", () => {
    const input = localSignup.buildInput({}, config);
    expect(input.fullName).toBeTruthy();
    expect(input.email).toMatch(/@/);
    expect(input.password.length).toBeGreaterThanOrEqual(8);
    expect(input.confirmPassword).toBe(input.password);
    expect(input).toMatchObject({ country: "BR", newsletter: false, acceptTerms: true });
  });

  it("respeita overrides e propaga password para confirmPassword", () => {
    const input = localSignup.buildInput(
      { email: "fixo@example.test", password: "minha-senha-123", country: "PT", newsletter: true },
      config,
    );
    expect(input).toMatchObject({
      email: "fixo@example.test",
      password: "minha-senha-123",
      confirmPassword: "minha-senha-123",
      country: "PT",
      newsletter: true,
    });
  });
});
