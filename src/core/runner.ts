/**
 * Executor genérico: recebe a definição de um workflow, monta o contexto,
 * roda os passos em ordem e devolve um resultado estruturado. Em caso de
 * falha salva screenshot; sempre salva um relatório JSON em `outputDir`.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "playwright-core";
import { openSession } from "./browser.js";
import type { BrowserOptions, RunResult, WorkflowConfig, WorkflowContext, WorkflowDefinition } from "./types.js";

export interface RunOptions<I> {
  config?: Partial<WorkflowConfig>;
  input?: Partial<I>;
  browser?: BrowserOptions;
  outputDir?: string;
  logger?: (msg: string) => void;
}

export async function runWorkflow<I, O>(
  workflow: WorkflowDefinition<I, O>,
  options: RunOptions<I> = {},
): Promise<RunResult<O>> {
  const log = options.logger ?? ((m: string) => console.log(m));
  const config: WorkflowConfig = { ...workflow.defaults, ...options.config } as WorkflowConfig;
  const input = workflow.buildInput(options.input ?? {}, config);
  const outputDir = options.outputDir ?? "runs";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${workflow.name}`;

  const result: RunResult<O> = {
    runId,
    workflow: workflow.name,
    ok: false,
    steps: [],
    startedAt: new Date().toISOString(),
  };

  const session = await openSession(options.browser);
  const ctx: WorkflowContext<I> = { page: session.page, input, config, state: {}, log };

  log(`▶ ${workflow.name} (${runId})`);
  try {
    for (const step of workflow.steps) {
      const t0 = Date.now();
      log(`• ${step.name}`);
      try {
        await step.run(ctx);
        result.steps.push({ name: step.name, ok: true, ms: Date.now() - t0 });
      } catch (err) {
        const message = (err as Error).message;
        result.steps.push({ name: step.name, ok: false, ms: Date.now() - t0, error: message });
        if (!step.optional) throw err;
        log(`  (opcional, ignorado) ${message}`);
      }
    }
    result.output = workflow.result ? await workflow.result(ctx) : (ctx.state as O);
    result.ok = true;
    log("✔ concluído");
  } catch (err) {
    result.error = (err as Error).message;
    result.screenshot = await saveScreenshot(session.page, outputDir, runId);
    log(`✖ falhou: ${result.error}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    await session.close();
  }

  result.reportPath = await saveReport(outputDir, runId, result);
  return result;
}

async function saveScreenshot(page: Page, dir: string, runId: string): Promise<string | undefined> {
  try {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${runId}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return undefined;
  }
}

async function saveReport(dir: string, runId: string, result: RunResult<unknown>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  // Nunca persiste a senha usada no cadastro.
  await writeFile(file, JSON.stringify(result, (k, v) => (/password/i.test(k) ? "[redacted]" : v), 2));
  return file;
}
