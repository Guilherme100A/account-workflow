/**
 * Gravar → replay → continuar, com navegador real contra o formulário local.
 * Só roda com E2E=1 (o 1º uso baixa o binário do CloakBrowser).
 *
 *   E2E=1 npx vitest run tests/recorder-e2e.test.ts
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "../test-site/server.js";
import { recordSession } from "../src/recorder/recorder.js";
import { replayRecording } from "../src/recorder/replay.js";
import { countAccounts, listAccounts } from "../src/recorder/accounts.js";
import { loadCheckpoint, loadRecording, saveRecording } from "../src/recorder/store.js";

describe.skipIf(process.env.E2E !== "1")("e2e: gravador", () => {
  const server = createTestServer();
  let baseUrl = "";
  let dir = "";
  const quiet = () => {};

  beforeAll(async () => {
    baseUrl = await server.listen(0);
    dir = await mkdtemp(path.join(os.tmpdir(), "account-rec-"));
  });
  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("grava um cadastro feito 'à mão' e salva sem a senha", async () => {
    const { recording, file } = await recordSession({
      name: "cadastro",
      url: baseUrl,
      recordingsDir: dir,
      browser: { headless: true },
      logger: quiet,
      async drive(page) {
        await page.locator("#fullName").pressSequentially("Maria Silva");
        await page.locator("#email").pressSequentially("maria@example.com");
        await page.locator("#password").pressSequentially("senha-gravada-123");
        await page.locator("#confirmPassword").pressSequentially("senha-gravada-123");
        await page.locator("#country").selectOption("PT");
        await page.locator("label:has(#terms)").click();
        await page.locator("#submit").click();
        await page.locator("#success").waitFor({ state: "visible" });
        await page.locator("#success h1").click({ modifiers: ["Alt"] }); // ponto de verificação
      },
    });

    expect(recording.steps.map((s) => s.type)).toEqual([
      "goto", "fill", "fill", "fill", "fill", "select", "check", "click", "waitVisible",
    ]);
    expect(recording.variables).toMatchObject({ email: "maria@example.com", password: null });
    expect(await readFile(file, "utf8")).not.toContain("senha-gravada-123");
    expect(server.accounts.size).toBe(1);
  }, 180_000);

  it("replica a gravação com outros dados", async () => {
    const rec = (await loadRecording("cadastro", dir))!;
    const result = await replayRecording(rec, {
      input: { email: "outra@example.com", password: "outra-senha-456" },
      browser: { headless: true },
      recordingsDir: dir,
      outputDir: dir,
      logger: quiet,
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect([...server.accounts.values()].map((a) => a.email)).toContain("outra@example.com");
  }, 180_000);

  it("salva checkpoint quando quebra e continua com --resume", async () => {
    const rec = (await loadRecording("cadastro", dir))!;
    const submit = rec.steps.findIndex((s) => s.type === "click");
    const broken = structuredClone(rec);
    broken.steps[submit] = { type: "click", selector: "#nao-existe" };
    await saveRecording(broken, dir);

    const failed = await replayRecording(broken, {
      input: { email: "terceira@example.com", password: "senha-789" },
      browser: { headless: true },
      timeout: 1_500,
      recordingsDir: dir,
      outputDir: dir,
      logger: quiet,
    });
    expect(failed.ok).toBe(false);
    expect(failed.failedStep).toBe(submit + 1);
    const cp = await loadCheckpoint("cadastro", dir);
    // Recomeça logo após a última navegação (o formulário é reaberto e
    // preenchido de novo; cookies/sessão são restaurados).
    expect(cp).toMatchObject({ failedStep: submit, nextStep: 1, url: rec.steps[0].type === "goto" ? rec.steps[0].url : "" });

    // "Conserta" o passo e continua.
    await saveRecording(rec, dir);
    const resumed = await replayRecording(rec, {
      resume: true,
      input: { email: "terceira@example.com", password: "senha-789" },
      browser: { headless: true },
      recordingsDir: dir,
      outputDir: dir,
      logger: quiet,
    });
    expect(resumed.error).toBeUndefined();
    expect(resumed.steps[0].name).toMatch(/^retomar em/);
    expect(resumed.steps.length).toBe(rec.steps.length); // "retomar" + passos 2..N
    expect([...server.accounts.values()].map((a) => a.email)).toContain("terceira@example.com");
    expect(await loadCheckpoint("cadastro", dir).catch(() => undefined)).toBeUndefined();
  }, 180_000);

  it("Alt+M marca login/senha e o replay salva a conta", async () => {
    await recordSession({
      name: "conta-salva",
      url: baseUrl,
      recordingsDir: dir,
      browser: { headless: true },
      logger: quiet,
      async drive(page) {
        await page.locator("#fullName").pressSequentially("Maria");
        await page.locator("#email").pressSequentially("salva@test.com");
        // Alt+M: marcar e-mail como login da conta
        await page.locator("#email").focus();
        await page.keyboard.press("Alt+KeyM");
        await page.locator("#__aw_rec_menu").waitFor();
        await page.keyboard.press("1"); // "Login / E-mail da conta"
        await page.locator("#password").pressSequentially("senha-conta-1");
        await page.locator("#password").focus();
        await page.keyboard.press("Alt+KeyM");
        await page.locator("#__aw_rec_menu").waitFor();
        await page.keyboard.press("2"); // "Senha da conta"
        await page.locator("#confirmPassword").pressSequentially("senha-conta-1");
        await page.locator("#country").selectOption("BR");
        await page.locator("label:has(#terms)").click();
        await page.locator("#submit").click();
        await page.locator("#success").waitFor({ state: "visible" });
      },
    });
    const rec = (await loadRecording("conta-salva", dir))!;
    expect(rec.accountFields).toEqual({ identifier: "email", password: "password" });

    const result = await replayRecording(rec, {
      input: { email: "replay-1@test.com", password: "nova-senha-1" },
      browser: { headless: true },
      recordingsDir: dir,
      outputDir: dir,
      logger: quiet,
    });
    expect(result.ok).toBe(true);
    expect(result.accountFile).toBeDefined();

    const accounts = await listAccounts("conta-salva", dir);
    expect(accounts.length).toBe(1);
    expect(accounts[0].identifier).toBe("replay-1@test.com");
    expect(accounts[0].password).toBe("nova-senha-1");

    // Segundo replay: gera outra conta
    await replayRecording(rec, {
      input: { email: "replay-2@test.com", password: "nova-senha-2" },
      browser: { headless: true },
      recordingsDir: dir,
      outputDir: dir,
      logger: quiet,
    });
    expect(await countAccounts("conta-salva", dir)).toBe(2);
  }, 180_000);

  it("Alt+G marca campos aleatórios e cada replay cria uma conta diferente", async () => {
    const { recording } = await recordSession({
      name: "aleatorio",
      url: baseUrl,
      recordingsDir: dir,
      browser: { headless: true },
      logger: quiet,
      async drive(page) {
        const pickRandom = async (sel: string, n: number) => {
          await page.locator(sel).focus();
          await page.keyboard.press("Alt+KeyG");
          await page.locator("#__aw_rec_menu").waitFor();
          await page.keyboard.press(String(n));
          await page.waitForFunction((s) => (document.querySelector(s) as HTMLInputElement).value !== "", sel);
        };
        await pickRandom("#fullName", 3);
        await pickRandom("#email", 4);
        await pickRandom("#password", 6);
        await pickRandom("#confirmPassword", 6);
        await page.locator("#country").selectOption("BR");
        await page.locator("label:has(#terms)").click();
        await page.locator("#submit").click();
        await page.locator("#success").waitFor({ state: "visible" });
        await page.locator("#success h1").click({ modifiers: ["Alt"] });
      },
    });
    const values = recording.steps.filter((s) => s.type === "fill").map((s) => (s as { value: string }).value);
    expect(values).toEqual(["{{gen.fullName}}", "{{gen.email}}", "{{gen.password}}", "{{gen.password}}"]);
    expect(recording.variables).toEqual({});

    const before = server.accounts.size;
    const emails = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const r = await replayRecording(recording, { browser: { headless: true }, recordingsDir: dir, outputDir: dir, logger: quiet });
      expect(r.error).toBeUndefined();
      emails.add((r.output as { generated: { email: string } }).generated.email);
      expect(await readFile(r.reportPath!, "utf8")).toContain("[redacted]");
    }
    expect(emails.size).toBe(2);
    expect(server.accounts.size).toBe(before + 2);
  }, 180_000);

  it("Alt+S captura valor da página e salva com a conta", async () => {
    const { recording } = await recordSession({
      name: "captura",
      url: baseUrl,
      recordingsDir: dir,
      browser: { headless: true },
      logger: quiet,
      async drive(page) {
        await page.locator("#fullName").pressSequentially("Test");
        await page.locator("#email").pressSequentially("captura@test.com");
        // Marca como login
        await page.locator("#email").focus();
        await page.keyboard.press("Alt+KeyM");
        await page.locator("#__aw_rec_menu").waitFor();
        await page.keyboard.press("1");
        await page.locator("#password").pressSequentially("senhaCap1!");
        await page.locator("#password").focus();
        await page.keyboard.press("Alt+KeyM");
        await page.locator("#__aw_rec_menu").waitFor();
        await page.keyboard.press("2");
        await page.locator("#confirmPassword").pressSequentially("senhaCap1!");
        await page.locator("#country").selectOption("BR");
        await page.locator("label:has(#terms)").click();
        await page.locator("#submit").click();
        await page.locator("#success").waitFor({ state: "visible" });
        // Alt+S: capturar o ID da conta exibido na tela
        await page.locator("#account-id").focus();
        await page.keyboard.press("Alt+KeyS");
        await page.locator("#__aw_rec_menu").waitFor();
        const nameInput = page.locator("#__aw_rec_menu input");
        await nameInput.fill("account_id");
        await nameInput.press("Enter");
      },
    });
    expect(recording.steps.find((s) => s.type === "readValue")).toMatchObject({ type: "readValue", saveAs: "account_id" });

    const result = await replayRecording(recording, {
      input: { email: "captura-replay@test.com", password: "senhaCap2!" },
      browser: { headless: true },
      recordingsDir: dir,
      outputDir: dir,
      logger: quiet,
    });
    expect(result.ok).toBe(true);
    const accounts = await listAccounts("captura", dir);
    expect(accounts.length).toBe(1);
    expect(accounts[0].identifier).toBe("captura-replay@test.com");
    expect(accounts[0].captured).toBeDefined();
    expect(accounts[0].captured!.account_id).toBeTruthy();
  }, 180_000);

  it("callApi com extract: pega código de SMS da API e verifica", async () => {
    // 1. Grava o cadastro normalmente
    const { recording } = await recordSession({
      name: "sms-flow",
      url: baseUrl,
      recordingsDir: dir,
      browser: { headless: true },
      logger: quiet,
      async drive(page) {
        await page.locator("#fullName").pressSequentially("Test SMS");
        await page.locator("#email").pressSequentially("sms@test.com");
        await page.locator("#password").pressSequentially("senhaSms123!");
        await page.locator("#confirmPassword").pressSequentially("senhaSms123!");
        await page.locator("#country").selectOption("BR");
        await page.locator("label:has(#terms)").click();
        await page.locator("#submit").click();
        await page.locator("#success").waitFor({ state: "visible" });
      },
    });

    // 2. Edita o JSON: readValue + callApi + extract + verify
    const rec = (await loadRecording("sms-flow", dir))!;
    rec.accountFields = { identifier: "email", password: "password" };
    // Lê o account-id da tela
    rec.steps.push({ type: "readValue", saveAs: "account_id", selector: "#account-id" });
    // Chama a API de SMS com o account_id como "phone" (é um teste, o importante é o fluxo)
    rec.steps.push({
      type: "callApi",
      method: "POST",
      url: baseUrl + "/api/sms",
      body: '{"phone": "{{read.account_id}}"}',
      extract: { sms_code: "code" },
      saveAs: "smsResponse",
    });
    // Verifica o código
    rec.steps.push({
      type: "callApi",
      method: "POST",
      url: baseUrl + "/api/verify-sms",
      body: '{"phone": "{{read.account_id}}", "code": "{{api.sms_code}}"}',
      saveAs: "verifyResponse",
    });
    await saveRecording(rec, dir);

    // 3. Replay
    const result = await replayRecording(rec, {
      input: { email: "sms-replay@test.com", password: "senhaSms456!" },
      browser: { headless: true },
      recordingsDir: dir,
      outputDir: dir,
      logger: quiet,
    });
    expect(result.ok).toBe(true);
    const out = result.output as { api?: Record<string, { status: number; body: unknown }> };
    expect(out.api?.smsResponse?.status).toBe(200);
    expect(out.api?.verifyResponse?.status).toBe(200);
    expect((out.api?.verifyResponse?.body as { verified: boolean })?.verified).toBe(true);
    // A conta foi salva com o account_id capturado
    const accounts = await listAccounts("sms-flow", dir);
    expect(accounts.length).toBe(1);
    expect(accounts[0].captured?.account_id).toBeTruthy();
  }, 180_000);

  it("continua uma gravação existente com append", async () => {
    const before = (await loadRecording("cadastro", dir))!.steps.length;
    const { recording } = await recordSession({
      name: "cadastro",
      append: true,
      input: { email: "quarta@example.com", password: "senha-000" },
      recordingsDir: dir,
      browser: { headless: true },
      logger: quiet,
      async drive(page) {
        await page.locator("#account-id").click({ modifiers: ["Alt"] });
      },
    });
    expect(recording.steps.length).toBe(before + 1);
    expect(recording.steps.at(-1)).toMatchObject({ type: "waitVisible", selector: "#account-id" });
  }, 180_000);
});
