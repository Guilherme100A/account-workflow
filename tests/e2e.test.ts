/**
 * Teste ponta a ponta com navegador headless (CloakBrowser).
 * Só roda com E2E=1 — o 1º uso baixa o binário (~200MB).
 *
 *   E2E=1 npx vitest run tests/e2e.test.ts
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "../test-site/server.js";
import { runWorkflow } from "../src/core/runner.js";
import localSignup from "../src/workflows/local-signup.js";

describe.skipIf(process.env.E2E !== "1")("e2e: local-signup", () => {
  const server = createTestServer();
  let baseUrl = "";
  let outputDir = "";

  beforeAll(async () => {
    baseUrl = await server.listen(0);
    outputDir = await mkdtemp(path.join(os.tmpdir(), "account-e2e-"));
  });
  afterAll(async () => {
    await server.close();
    await rm(outputDir, { recursive: true, force: true });
  });

  it("cadastra uma conta pelo formulário", async () => {
    const password = "e2e-senha-secreta-123";
    const result = await runWorkflow(localSignup, {
      config: { baseUrl },
      input: { password },
      browser: { headless: true },
      outputDir,
      logger: () => {},
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.steps.every((s) => s.ok)).toBe(true);

    expect(server.accounts.size).toBe(1);
    const account = [...server.accounts.values()][0];
    expect(result.output).toEqual({ accountId: account.id, email: account.email });

    const report = await readFile(result.reportPath!, "utf8");
    expect(JSON.parse(report).workflow).toBe("local-signup");
    expect(report).not.toContain(password);
  }, 180_000);
});
