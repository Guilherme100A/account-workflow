/** Gerador simples de dados fictícios para preencher formulários de teste. */

import crypto from "node:crypto";

const FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabriela", "Heitor"];
const LAST = ["Silva", "Souza", "Oliveira", "Pereira", "Costa", "Rodrigues", "Almeida"];

const pick = <T>(arr: T[]): T => arr[crypto.randomInt(arr.length)];

export interface FakePerson {
  fullName: string;
  email: string;
  password: string;
}

/** `.test` é um TLD reservado (RFC 2606) — nunca resolve para um domínio real. */
export function fakePerson({ emailDomain = "example.test" } = {}): FakePerson {
  const first = pick(FIRST);
  const last = pick(LAST);
  const tag = crypto.randomBytes(3).toString("hex");
  const slug = `${first}.${last}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return {
    fullName: `${first} ${last}`,
    email: `${slug}.${tag}@${emailDomain}`,
    password: `T3ste!${crypto.randomBytes(6).toString("base64url")}`,
  };
}
