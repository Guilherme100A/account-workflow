/**
 * CLI dos workflows.
 *
 * Usage:
 *   npx tsx src/cli.ts list
 *   npx tsx src/cli.ts run <workflow> [--serve] [--headed] [--humanize] [--slow-mo 200]
 *                                     [--base-url URL] [--set campo=valor ...]
 *
 *   --serve   sobe o formulário de teste local numa porta livre e usa-o como baseUrl
 *   --set     sobrescreve campos do input (ex.: --set country=PT --set newsletter=true)
 */

import { parseArgs } from "node:util";
import { proxyFromEnvironment } from "./core/proxy.js";
import { runWorkflow } from "./core/runner.js";
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

if (command === "list") {
  for (const wf of registry.list()) console.log(`${wf.name.padEnd(20)} ${wf.description}`);
} else if (command === "run" && name) {
  const workflow = registry.get(name);
  const server = values.serve ? createTestServer() : null;
  const baseUrl = server ? await server.listen(0) : values["base-url"];

  try {
    const result = await runWorkflow(workflow, {
      config: baseUrl ? { baseUrl } : {},
      input: parseSet(values.set!),
      browser: {
        proxy: proxyFromEnvironment(process.env, values.proxy),
        headless: !values.headed,
        humanize: values.humanize,
        slowMo: values["slow-mo"] ? Number(values["slow-mo"]) : undefined,
      },
    });
    console.log(JSON.stringify({ ok: result.ok, output: result.output, error: result.error, screenshot: result.screenshot, report: result.reportPath }, null, 2));
    if (server) console.log(`Contas no servidor local: ${server.accounts.size}`);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await server?.close();
  }
} else {
  console.error("Uso: tsx src/cli.ts list | run <workflow> [--serve] [--headed] [--humanize] [--set k=v]");
  process.exitCode = 2;
}
