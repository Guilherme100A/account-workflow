/**
 * Valores aleatórios para campos marcados com Alt+G na gravação.
 *
 * No arquivo o passo fica como `{{gen.<tipo>}}` e a cada execução é gerado
 * um conjunto novo e coerente (o e-mail e o usuário derivam do mesmo nome).
 * Qualquer um pode ser fixado com `--set gen.<tipo>=valor`.
 */

import crypto from "node:crypto";
import { fakePerson } from "../core/data.js";

export const GENERATORS = {
  firstName: "Nome",
  lastName: "Sobrenome",
  fullName: "Nome completo",
  email: "E-mail",
  username: "Usuário",
  password: "Senha",
  number: "Número (6 dígitos)",
} as const;

export type GeneratorKind = keyof typeof GENERATORS;

export const GEN_PREFIX = "gen.";

export const isGeneratorVar = (name: string) => name.startsWith(GEN_PREFIX);

export function isGeneratorKind(k: string): k is GeneratorKind {
  return Object.hasOwn(GENERATORS, k);
}

export type GeneratedValues = Record<`gen.${GeneratorKind}`, string>;

/** Domínio dos e-mails gerados (padrão: `example.test`, que nunca resolve). */
export const emailDomain = () => process.env.WORKFLOW_EMAIL_DOMAIN || "example.test";

/** Gera um conjunto novo de valores (um por execução/gravação). */
export function generateValues(domain = emailDomain()): GeneratedValues {
  const p = fakePerson({ emailDomain: domain });
  const local = p.email.split("@")[0];
  return {
    "gen.firstName": p.firstName,
    "gen.lastName": p.lastName,
    "gen.fullName": p.fullName,
    "gen.email": p.email,
    "gen.username": local.replace(/\./g, "_"),
    "gen.password": p.password,
    "gen.number": String(crypto.randomInt(100_000, 1_000_000)),
  };
}
