/**
 * Salva e lista as contas criadas por replays bem-sucedidos.
 *
 * Cada gravação que tenha `accountFields` (ou variáveis gen.email / gen.password)
 * gera uma linha em `recordings/<nome>.accounts.jsonl` por execução.
 * JSONL para não carregar tudo na memória quando o arquivo cresce.
 */

import path from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { Recording } from "./types.js";
import { isGeneratorVar } from "./generators.js";
import { variablesUsed } from "./replay.js";

export interface SavedAccount {
  /** Identificador da conta (e-mail, nome de usuário…). */
  identifier: string;
  /** Senha usada (em texto, para poder replicar o login depois). */
  password: string;
  /** Todas as variáveis usadas nesta execução (sem a senha). */
  fields: Record<string, string>;
  /** Valores capturados da página com `readValue` / Alt+S (ex.: telefone, código). */
  captured?: Record<string, string>;
  /** URL inicial da gravação. */
  url: string;
  /** Horário da criação (ISO 8601). */
  createdAt: string;
  /** ID do relatório de execução, para rastrear. */
  runId?: string;
}

const accountsPath = (name: string, dir: string) => path.join(dir, `${name}.accounts.jsonl`);

/**
 * Descobre qual variável é o identificador e qual é a senha, olhando:
 *  1. `rec.accountFields` (marcação manual: Alt+M durante a gravação ou edição do JSON)
 *  2. Variáveis `gen.email` / `gen.password` (marcação via Alt+G)
 *  3. Nomes comuns de variáveis: email, username, user, login… e password, senha…
 */
export function detectAccountVars(rec: Recording): { identifier?: string; password?: string } {
  // 1. Marcação explícita
  if (rec.accountFields?.identifier || rec.accountFields?.password) {
    return { identifier: rec.accountFields.identifier, password: rec.accountFields.password };
  }

  const vars = new Set(variablesUsed(rec.steps));

  // 2. gen.* (do Alt+G)
  const genId = ["gen.email", "gen.username"].find((v) => vars.has(v));
  const genPw = vars.has("gen.password") ? "gen.password" : undefined;
  if (genId || genPw) return { identifier: genId, password: genPw };

  // 3. Nomes comuns
  const idNames = ["email", "username", "user", "login", "e_mail", "usuario"];
  const pwNames = ["password", "senha", "pass", "pwd"];
  // Procura variável que não é gen.* e tem nome parecido
  const userVars = [...vars].filter((v) => !isGeneratorVar(v));
  const identifier = idNames.find((n) => userVars.includes(n)) ?? userVars.find((v) => idNames.some((n) => v.toLowerCase().includes(n)));
  const password = pwNames.find((n) => userVars.includes(n)) ?? userVars.find((v) => pwNames.some((n) => v.toLowerCase().includes(n)));

  return { identifier, password };
}

/** Salva a conta no arquivo JSONL. Retorna o caminho. */
export async function saveAccount(
  rec: Recording,
  input: Record<string, string>,
  runId: string | undefined,
  dir: string,
): Promise<{ file: string; account: SavedAccount } | undefined> {
  const { identifier: idVar, password: pwVar } = detectAccountVars(rec);
  if (!idVar && !pwVar) return undefined; // sem campos marcados

  const identifier = idVar ? input[idVar] : "(desconhecido)";
  const password = pwVar ? input[pwVar] : "(desconhecido)";

  // Fields: todas as variáveis usadas, EXCETO a senha.
  const fields: Record<string, string> = {};
  for (const v of variablesUsed(rec.steps)) {
    if (v === pwVar) continue;
    const val = input[v];
    if (val !== undefined) fields[v] = val;
  }

  // Valores capturados da página (read.*)
  const captured: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("read.") && v) captured[k.slice(5)] = v;
  }

  const account: SavedAccount = {
    identifier,
    password,
    fields,
    ...(Object.keys(captured).length ? { captured } : {}),
    url: rec.startUrl,
    createdAt: new Date().toISOString(),
    runId,
  };

  const file = accountsPath(rec.name, dir);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(account) + "\n");
  return { file, account };
}

/** Lista contas salvas (mais recente por último). */
export async function listAccounts(name: string, dir: string): Promise<SavedAccount[]> {
  const file = accountsPath(name, dir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as SavedAccount; } catch { return undefined; }
    })
    .filter((a): a is SavedAccount => a !== undefined);
}

/** Conta quantas contas foram salvas. */
export async function countAccounts(name: string, dir: string): Promise<number> {
  try {
    const text = await readFile(accountsPath(name, dir), "utf8");
    return text.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
