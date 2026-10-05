/**
 * Workflow de cadastro no formulário de teste local (test-site/).
 * Fluxo multi-etapas: dados pessoais → verificação SMS → tela de sucesso.
 */

import { fakePerson } from "../core/data.js";
import { defineWorkflow } from "../core/registry.js";
import {
  assert,
  click,
  collectErrors,
  custom,
  extractText,
  fillForm,
  goto,
  optional,
  submitAndCapture,
  waitVisible,
  when,
  solveCaptcha,
} from "../core/steps.js";

export interface LocalSignupInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  country: string;
  newsletter: boolean;
  acceptTerms: boolean;
}

export interface LocalSignupOutput {
  accountId: string;
  email: string;
  phone: string;
  verified: boolean;
}

interface RegisterResponse {
  status: number;
  body: { ok: boolean; account?: { id: string }; errors?: Record<string, string> } | null;
}

interface SmsResponse {
  status: number;
  body: { ok: boolean; code?: string } | null;
}

export default defineWorkflow<LocalSignupInput, LocalSignupOutput>({
  name: "local-signup",
  description: "Cadastro multi-etapas no formulário de teste local (dados + SMS + sucesso)",
  defaults: { baseUrl: "http://127.0.0.1:3000" },

  buildInput(overrides) {
    const person = fakePerson();
    const password = overrides.password ?? person.password;
    const phone = overrides.phone ?? `+55 11 9${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`;
    return {
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      phone,
      password,
      confirmPassword: password,
      country: "BR",
      newsletter: false,
      acceptTerms: true,
      ...overrides,
    };
  },

  steps: [
    // --- Etapa 1: Dados pessoais ---
    goto("/", { waitFor: "#signup-form" }),
    fillForm({
      "#firstName": (ctx) => ctx.input.firstName,
      "#lastName": (ctx) => ctx.input.lastName,
      "#email": (ctx) => ctx.input.email,
      "#phone": (ctx) => ctx.input.phone,
      "#password": (ctx) => ctx.input.password,
      "#confirmPassword": (ctx) => ctx.input.confirmPassword,
      "#country": (ctx) => ctx.input.country,
      "#newsletter": (ctx) => ctx.input.newsletter,
      "#terms": (ctx) => ctx.input.acceptTerms,
    }),
    when(
      async (ctx) =>
        (await ctx.page.locator("#signup-form").getAttribute("data-captcha-enabled")) === "true",
      solveCaptcha('[name="g-recaptcha-response"]'),
    ),
    submitAndCapture("#submit", { urlPart: "/api/register", saveAs: "signup" }),
    optional(collectErrors(".error")),
    assert("servidor aceitou o cadastro", (ctx) => {
      const res = ctx.state.signup as RegisterResponse;
      if (res.status !== 201) {
        throw new Error(
          `HTTP ${res.status}: ${JSON.stringify(res.body?.errors ?? ctx.state.formErrors)}`,
        );
      }
      return true;
    }),

    // --- Etapa 2: Verificação SMS ---
    waitVisible("#step-2"),
    custom("buscar código SMS via API", async (ctx) => {
      const res = await fetch(`${ctx.config.baseUrl}/api/sms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: ctx.input.phone }),
      });
      const body = await res.json();
      ctx.state.smsCode = body.code;
      ctx.log(`  código SMS: ${body.code}`);
    }),
    custom("preencher código SMS", async (ctx) => {
      const code = ctx.state.smsCode as string;
      const inputs = ctx.page.locator("#code-inputs input");
      for (let i = 0; i < 6; i++) {
        await inputs.nth(i).fill(code[i]);
      }
    }),
    submitAndCapture("#verify-submit", { urlPart: "/api/verify-sms", saveAs: "verify" }),
    assert("SMS verificado", (ctx) => {
      const res = ctx.state.verify as { status: number; body: { ok: boolean } | null };
      return res.status === 200 && res.body?.ok === true;
    }),

    // --- Etapa 3: Sucesso ---
    waitVisible('[data-testid="signup-success"]'),
    extractText("#account-id", "accountId"),
    extractText("#display-email", "displayEmail"),
    extractText("#display-phone", "displayPhone"),
    assert("ID exibido confere com a API", (ctx) => {
      const res = ctx.state.signup as RegisterResponse;
      return ctx.state.accountId === res.body?.account?.id;
    }),
    assert("e-mail exibido confere", (ctx) => {
      return ctx.state.displayEmail === ctx.input.email;
    }),
  ],

  result: (ctx) => ({
    accountId: ctx.state.accountId as string,
    email: ctx.input.email,
    phone: ctx.input.phone,
    verified: true,
  }),
});
