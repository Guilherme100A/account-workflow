import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer, validateRegistration, type RegistrationPayload } from "../test-site/server.js";

const valid: RegistrationPayload = {
  firstName: "Maria",
  lastName: "Silva",
  fullName: "Maria Silva",
  email: "maria@example.test",
  phone: "+55 11 99999-0000",
  password: "S3nha!forte",
  confirmPassword: "S3nha!forte",
  country: "BR",
  newsletter: true,
  terms: true,
};

describe("validateRegistration", () => {
  it("aceita um cadastro válido", () => {
    expect(validateRegistration(valid)).toEqual({});
  });

  it.each<[string, Partial<RegistrationPayload>]>([
    ["firstName", { firstName: "A" }],
    ["lastName", { lastName: "B" }],
    ["email", { email: "sem-arroba" }],
    ["phone", { phone: "123" }],
    ["password", { password: "S3nha!f", confirmPassword: "S3nha!f" }],
    ["confirmPassword", { confirmPassword: "outra-senha" }],
    ["country", { country: "XX" }],
    ["terms", { terms: false }],
  ])("reporta erro em %s", (field, patch) => {
    const errors = validateRegistration({ ...valid, ...patch });
    expect(errors).toHaveProperty(field);
  });

  it("payload vazio reporta todos os campos obrigatórios", () => {
    expect(Object.keys(validateRegistration({})).sort()).toEqual(
      ["country", "email", "firstName", "lastName", "password", "phone", "terms"].sort(),
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
    expect(data.account).toMatchObject({
      fullName: "Maria Silva",
      email: valid.email,
      phone: valid.phone,
      country: "BR",
      newsletter: true,
      verified: false,
    });
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
    const res = await register({ ...valid, firstName: "Outra", lastName: "Pessoa" });
    expect(res.status).toBe(422);
    expect((await res.json()).errors.email).toBe("E-mail já cadastrado");
  });

  it("POST /api/sms retorna código de 6 dígitos", async () => {
    const res = await fetch(`${baseUrl}/api/sms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+55 11 99999-0000" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.code).toMatch(/^\d{6}$/);
  });

  it("POST /api/verify-sms valida o código e marca conta como verificada", async () => {
    const phone = "+55 11 88888-0000";
    const uniqueEmail = "verify-test@example.test";
    await register({ ...valid, email: uniqueEmail, phone });
    const smsRes = await fetch(`${baseUrl}/api/sms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const { code } = await smsRes.json();

    const verifyRes = await fetch(`${baseUrl}/api/verify-sms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    expect(verifyRes.status).toBe(200);
    expect((await verifyRes.json()).ok).toBe(true);

    const account = [...server.accounts.values()].find((a) => a.phone === phone);
    expect(account?.verified).toBe(true);
  });

  it("POST /api/verify-sms rejeita código errado", async () => {
    await fetch(`${baseUrl}/api/sms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+55 11 77777-0000" }),
    });
    const res = await fetch(`${baseUrl}/api/verify-sms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+55 11 77777-0000", code: "000000" }),
    });
    expect(res.status).toBe(422);
  });

  it("GET /api/accounts lista as contas criadas", async () => {
    const res = await fetch(`${baseUrl}/api/accounts`);
    expect(res.status).toBe(200);
    const accounts = await res.json();
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    expect(accounts[0].email).toBe(valid.email);
  });

  it("GET / serve o formulário", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("signup-form");
  });
});
