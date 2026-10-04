/**
 * Workflow de cadastro no formulário de teste local (test-site/).
 * Serve também de modelo: copie este arquivo para criar novos workflows.
 */

import { fakePerson } from "../core/data.js";
import { defineWorkflow } from "../core/registry.js";
import { assert, collectErrors, extractText, fillForm, goto, submitAndCapture, optional, waitVisible } from "../core/steps.js";

export interface LocalSignupInput {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  country: string;
  newsletter: boolean;
  acceptTerms: boolean;
}

export interface LocalSignupOutput {
  accountId: string;
  email: string;
}

interface SignupResponse {
  status: number;
  body: { ok: boolean; account?: { id: string }; errors?: Record<string, string> } | null;
}

export default defineWorkflow<LocalSignupInput, LocalSignupOutput>({
  name: "local-signup",
  description: "Cadastro no formulário de teste local (test-site/)",
  defaults: { baseUrl: "http://127.0.0.1:3000" },

  buildInput(overrides) {
    const person = fakePerson();
    const password = overrides.password ?? person.password;
    return {
      ...person,
      password,
      confirmPassword: password,
      country: "BR",
      newsletter: false,
      acceptTerms: true,
      ...overrides,
    };
  },

  steps: [
    goto("/", { waitFor: "#signup-form" }),
    fillForm({
      "#fullName": (ctx) => ctx.input.fullName,
      "#email": (ctx) => ctx.input.email,
      "#password": (ctx) => ctx.input.password,
      "#confirmPassword": (ctx) => ctx.input.confirmPassword,
      "#country": (ctx) => ctx.input.country,
      "#newsletter": (ctx) => ctx.input.newsletter,
      "#terms": (ctx) => ctx.input.acceptTerms,
    }),
    submitAndCapture("#submit", { urlPart: "/api/register", saveAs: "signup" }),
    // Se o servidor recusou, registra as mensagens exibidas antes de falhar.
    optional(collectErrors(".error")),
    assert("servidor aceitou o cadastro", (ctx) => {
      const res = ctx.state.signup as SignupResponse;
      if (res.status !== 201) {
        throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body?.errors ?? ctx.state.formErrors)}`);
      }
      return true;
    }),
    waitVisible('[data-testid="signup-success"]'),
    extractText("#account-id", "accountId"),
    assert("ID exibido confere com a API", (ctx) => {
      const res = ctx.state.signup as SignupResponse;
      return ctx.state.accountId === res.body?.account?.id;
    }),
  ],

  result: (ctx) => ({
    accountId: ctx.state.accountId as string,
    email: ctx.input.email,
  }),
});
