import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer, validateRegistration, type RegistrationPayload } from "../test-site/server.js";

const valid: RegistrationPayload = {
  fullName: "Maria Silva",
  email: "maria@example.test",
  password: "s3nha-forte",
  confirmPassword: "s3nha-forte",
  country: "BR",
  newsletter: true,
  terms: true,
};

describe("validateRegistration", () => {
  it("aceita um cadastro válido", () => {
    expect(validateRegistration(valid)).toEqual({});
  });

  it.each<[keyof RegistrationPayload, Partial<RegistrationPayload>]>([
    ["fullName", { fullName: "  Al " }],
    ["email", { email: "sem-arroba" }],
    ["password", { password: "curta", confirmPassword: "curta" }],
    ["confirmPassword", { confirmPassword: "outra-senha" }],
    ["country", { country: "XX" }],
    ["terms", { terms: false }],
  ])("reporta erro em %s", (field, patch) => {
    const errors = validateRegistration({ ...valid, ...patch });
    expect(Object.keys(errors)).toEqual([field]);
  });

  it("payload vazio reporta todos os campos obrigatórios", () => {
    expect(Object.keys(validateRegistration({})).sort()).toEqual(
      ["country", "email", "fullName", "password", "terms"].sort(),
    );
  });
});

describe("API HTTP do test-site", () => {
  const server = createTestServer();
  let baseUrl = "";

  const register = (body: RegistrationPayload) =>
    fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    baseUrl = await server.listen(0);
  });
  afterAll(() => server.close());

  it("POST /api/register cria a conta (201)", async () => {
    const res = await register(valid);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.account).toMatchObject({ fullName: "Maria Silva", email: valid.email, country: "BR", newsletter: true });
    expect(data.account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.account).not.toHaveProperty("password");
  });

  it("POST /api/register com dados inválidos retorna 422 com erros", async () => {
    const res = await register({ ...valid, email: "ruim", terms: false });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(Object.keys(data.errors).sort()).toEqual(["email", "terms"]);
  });

  it("POST /api/register com e-mail duplicado retorna 422", async () => {
    const res = await register({ ...valid, fullName: "Outra Pessoa" });
    expect(res.status).toBe(422);
    expect((await res.json()).errors.email).toBe("E-mail já cadastrado");
  });

  it("GET /api/accounts lista apenas as contas criadas", async () => {
    const res = await fetch(`${baseUrl}/api/accounts`);
    expect(res.status).toBe(200);
    const accounts = await res.json();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe(valid.email);
    expect(server.accounts.size).toBe(1);
  });

  it("GET / serve o formulário", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("signup-form");
  });
});
