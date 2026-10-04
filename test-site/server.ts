/**
 * Servidor local de teste: serve o formulário de cadastro e valida/armazena
 * os cadastros em memória. Sem dependências externas.
 *
 * Usage:
 *   npx tsx test-site/server.ts [porta]
 */

import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRIES = new Set(["BR", "PT", "US", "AR"]);

export interface RegistrationPayload {
  fullName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  country?: string;
  newsletter?: boolean;
  terms?: boolean;
}

export interface Account {
  id: string;
  fullName: string;
  email: string;
  country: string;
  newsletter: boolean;
  createdAt: string;
}

export function validateRegistration(body: RegistrationPayload): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!body.fullName || body.fullName.trim().length < 3) errors.fullName = "Nome muito curto";
  if (!EMAIL_RE.test(body.email ?? "")) errors.email = "E-mail inválido";
  if (!body.password || body.password.length < 8) errors.password = "Senha precisa de 8+ caracteres";
  if (body.password !== body.confirmPassword) errors.confirmPassword = "Senhas não conferem";
  if (!COUNTRIES.has(body.country ?? "")) errors.country = "País inválido";
  if (body.terms !== true) errors.terms = "Aceite os termos";
  return errors;
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<RegistrationPayload> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createTestServer() {
  const accounts = new Map<string, Account>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/api/register") {
        const body = await readBody(req);
        const errors = validateRegistration(body);
        if ([...accounts.values()].some((a) => a.email === body.email)) errors.email = "E-mail já cadastrado";
        if (Object.keys(errors).length) return json(res, 422, { ok: false, errors });

        const account: Account = {
          id: crypto.randomUUID(),
          fullName: body.fullName!.trim(),
          email: body.email!,
          country: body.country!,
          newsletter: Boolean(body.newsletter),
          createdAt: new Date().toISOString(),
        };
        accounts.set(account.id, account);
        return json(res, 201, { ok: true, account });
      }

      if (req.method === "GET" && url.pathname === "/api/accounts") {
        return json(res, 200, [...accounts.values()]);
      }

      if (req.method === "GET") {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const full = path.join(PUBLIC_DIR, file);
        if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });
        const content = await readFile(full);
        res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
        return res.end(content);
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      json(res, e.code === "ENOENT" ? 404 : 500, { error: e.message });
    }
  });

  return {
    accounts,
    /** Porta 0 = porta livre aleatória. Resolve com a URL base. */
    listen(port = 3000, host = "127.0.0.1"): Promise<string> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address() as { port: number };
          resolve(`http://${host}:${addr.port}`);
        });
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 3000);
  const url = await createTestServer().listen(port);
  console.log(`Formulário de teste em ${url}`);
}
