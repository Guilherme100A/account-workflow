/**
 * CLI dos workflows.
 *
 * Usage:
 *   npx tsx src/cli.ts list
 *   npx tsx src/cli.ts run <workflow> [--serve] [--headed] [--humanize] [--slow-mo 200]
 *                                     [--base-url URL] [--set campo=valor ...]
 *
 *   npx tsx src/cli.ts record <nome> --url <site> [--force]   grava o que você faz no navegador
 *   npx tsx src/cli.ts record <nome> --append [--set k=v]      reexecuta e continua gravando
 *   npx tsx src/cli.ts show <nome>                             lista os passos e variáveis
 *   npx tsx src/cli.ts replay <nome> [--resume | --from N] [--headed] [--set k=v] [--base-url URL]
 *
 *   --serve   sobe o formulário de teste local numa porta livre e usa-o como baseUrl
 *   --set     sobrescreve campos do input / variáveis da gravação (ex.: --set email=a@b.com)
 */

import { parseArgs } from "node:util";
import { proxyFromEnvironment } from "./core/proxy.js";
import { runWorkflow } from "./core/runner.js";
import { describeStep } from "./recorder/builder.js";
import { recordSession } from "./recorder/recorder.js";
import { countAccounts, listAccounts } from "./recorder/accounts.js";
import { isGeneratorVar } from "./recorder/generators.js";
import { replayRecording, variablesUsed } from "./recorder/replay.js";
import { listRecordings, loadCheckpoint, loadRecording } from "./recorder/store.js";
import { registry } from "./workflows/index.js";
import { createTestServer } from "../test-site/server.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    serve: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    humanize: { type: "boolean", default: false },
    "slow-mo": { type: "string" },
    "base-url": { type: "string" },
    proxy: { type: "string" },
    set: { type: "string", multiple: true, default: [] },
    // gravação / replay
    url: { type: "string" },
    description: { type: "string" },
    append: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    resume: { type: "boolean", default: false },
    from: { type: "string" },
    timeout: { type: "string" },
    "no-captcha": { type: "boolean", default: false },
  },
});

const [command, name] = positionals;

function parseSet(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 1) throw new Error(`--set inválido: "${pair}" (use campo=valor)`);
    const raw = pair.slice(i + 1);
    out[pair.slice(0, i)] = raw === "true" ? true : raw === "false" ? false : raw;
  }
  return out;
}

const browserOptions = () => ({
  proxy: proxyFromEnvironment(process.env, values.proxy),
  headless: !values.headed,
  humanize: values.humanize,
  slowMo: values["slow-mo"] ? Number(values["slow-mo"]) : undefined,
});

async function withServer<T>(fn: (baseUrl: string | undefined) => Promise<T>): Promise<T> {
  const server = values.serve ? createTestServer() : null;
  const baseUrl = server ? await server.listen(0) : values["base-url"];
  try {
    return await fn(baseUrl);
  } finally {
    if (server) console.log(`Contas no servidor local: ${server.accounts.size}`);
    await server?.close();
  }
}

async function main(): Promise<void> {
  if (command === "list") {
    for (const wf of registry.list()) console.log(`${wf.name.padEnd(20)} ${wf.description}`);
    for (const rec of await listRecordings()) {
      const cp = await loadCheckpoint(rec.name).catch(() => undefined);
      const extra = cp ? ` — parou no passo ${cp.failedStep + 1} (replay --resume)` : "";
      console.log(`${rec.name.padEnd(20)} [gravação, ${rec.steps.length} passos] ${rec.description}${extra}`);
    }
  } else if (command === "run" && name) {
    const workflow = registry.get(name);
    await withServer(async (baseUrl) => {
      const result = await runWorkflow(workflow, {
        config: baseUrl ? { baseUrl } : {},
        input: parseSet(values.set!),
        browser: browserOptions(),
      });
      console.log(JSON.stringify({ ok: result.ok, output: result.output, error: result.error, screenshot: result.screenshot, report: result.reportPath }, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    });
  } else if (command === "record" && name) {
    await withServer(async (baseUrl) => {
      await recordSession({
        name,
        url: values.url ?? baseUrl,
        description: values.description,
        append: values.append,
        force: values.force,
        input: parseSet(values.set!),
        // Gravação é sempre com a janela visível.
        browser: { ...browserOptions(), headless: false },
      });
    });
  } else if (command === "show" && name) {
    const rec = await loadRecording(name);
    if (!rec) throw new Error(`Gravação "${name}" não encontrada`);
    console.log(`${rec.name} — ${rec.description}\ninício: ${rec.startUrl}\n`);
    rec.steps.forEach((s, i) => console.log(`${String(i + 1).padStart(3)}. ${describeStep(s)}`));
    console.log("\nvariáveis (sobrescreva com --set nome=valor):");
    for (const [k, v] of Object.entries(rec.variables)) console.log(`  ${k} = ${v === null ? "(não salva — obrigatória)" : JSON.stringify(v)}`);
    const gens = variablesUsed(rec.steps).filter(isGeneratorVar);
    if (gens.length) console.log(`\naleatórios (novos a cada execução; fixe com --set): ${gens.join(", ")}`);
    if (rec.accountFields) {
      console.log(`\ncampos da conta:`);
      if (rec.accountFields.identifier) console.log(`  identificador: {{${rec.accountFields.identifier}}}`);
      if (rec.accountFields.password) console.log(`  senha: {{${rec.accountFields.password}}}`);
    }
    const n = await countAccounts(name, "recordings");
    if (n) console.log(`\n${n} conta(s) criada(s) — npm run workflow -- accounts ${name}`);
    const cp = await loadCheckpoint(name);
    if (cp) console.log(`\ncheckpoint: falhou no passo ${cp.failedStep + 1} (${cp.error ?? ""}); --resume recomeça do passo ${cp.nextStep + 1}`);
  } else if (command === "replay" && name) {
    const rec = await loadRecording(name);
    if (!rec) throw new Error(`Gravação "${name}" não encontrada`);
    if (values.resume && values.from) throw new Error("Use --resume OU --from, não os dois");
    await withServer(async (baseUrl) => {
      const result = await replayRecording(rec, {
        resume: values.resume,
        fromStep: values.from ? Number(values.from) : undefined,
        input: parseSet(values.set!),
        baseUrl,
        timeout: values.timeout ? Number(values.timeout) : undefined,
        captcha: !values["no-captcha"],
        browser: browserOptions(),
      });
      const out = result.output as { generated?: Record<string, string>; api?: Record<string, unknown> } | undefined;
      const generated = out?.generated;
      const api = out?.api;
      console.log(JSON.stringify({ ok: result.ok, ...(generated && Object.keys(generated).length ? { generated } : {}), ...(api && Object.keys(api).length ? { api } : {}), error: result.error, failedStep: result.failedStep, checkpoint: result.checkpoint, screenshot: result.screenshot, report: result.reportPath }, null, 2));
      if (!result.ok) console.log(`Para continuar de onde parou: npm run workflow -- replay ${name} --resume --headed`);
      process.exitCode = result.ok ? 0 : 1;
    });
  } else if (command === "accounts" && name) {
    const accounts = await listAccounts(name, "recordings");
    if (!accounts.length) { console.log(`Nenhuma conta salva para "${name}".`); }
    else {
      console.log(`${accounts.length} conta(s) de "${name}":\n`);
      for (const [i, a] of accounts.entries()) {
        const date = new Date(a.createdAt).toLocaleString();
        console.log(`${String(i + 1).padStart(3)}. ${a.identifier}  /  ${a.password}  (${date})`);
        if (a.runId) console.log(`     run: ${a.runId}`);
      }
    }
  } else {
    console.error(
      [
        "Uso:",
        "  tsx src/cli.ts list",
        "  tsx src/cli.ts run <workflow> [--serve] [--headed] [--humanize] [--set k=v]",
        "  tsx src/cli.ts record <nome> --url <site> [--force] | --append [--set k=v]",
        "  tsx src/cli.ts show <nome>",
        "  tsx src/cli.ts replay <nome> [--resume | --from N] [--headed] [--set k=v] [--base-url URL]",
        "  tsx src/cli.ts accounts <nome>                                            — lista contas criadas",
      ].join("\n"),
    );
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`✖ ${(err as Error).message}`);
  process.exitCode = 1;
});
