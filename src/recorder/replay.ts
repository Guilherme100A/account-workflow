/**
 * Replay de gravações: converte uma `Recording` num `WorkflowDefinition`
 * comum (mesmo runner, relatório e screenshot dos workflows em código) e
 * salva um checkpoint quando falha, para continuar com `--resume`.
 */

import type { Locator } from "playwright-core";
import { defineWorkflow } from "../core/registry.js";
import { runWorkflow } from "../core/runner.js";
import type { BrowserOptions, RunResult, Step, WorkflowContext, WorkflowDefinition } from "../core/types.js";
import { describeStep } from "./builder.js";
import { CaptchaGuard, type CaptchaGuardOptions } from "./captcha-guard.js";
import { generateValues, isGeneratorVar } from "./generators.js";
import { saveAccount } from "./accounts.js";
import { clearCheckpoint, DEFAULT_DIR, loadCheckpoint, saveCheckpoint } from "./store.js";
import type { RecordedStep, Recording, Target } from "./types.js";

type Vars = Record<string, string>;
type Ctx = WorkflowContext<Vars>;

const VAR_RE = /\{\{([\w.]+)\}\}/g;
const DEFAULT_TIMEOUT = 15_000;

export interface ToWorkflowOptions {
  /** Índice (0-based) do primeiro passo a executar. */
  from?: number;
  /** URL aberta antes do primeiro passo (usada ao continuar de um checkpoint). */
  resumeUrl?: string;
  /** Tempo máximo para achar cada elemento / esperar cada navegação. */
  timeout?: number;
}

/** Variáveis referenciadas pelos passos. */
export function variablesUsed(steps: RecordedStep[]): string[] {
  const names = new Set<string>();
  for (const s of steps) {
    if ("value" in s) for (const m of s.value.matchAll(VAR_RE)) names.add(m[1]);
  }
  return [...names];
}

/** Variáveis sem valor salvo (senhas) e senhas geradas — mascaradas nos logs. */
const sensitiveVars = (rec: Recording) =>
  new Set([
    ...Object.entries(rec.variables).filter(([, v]) => v === null).map(([k]) => k),
    "gen.password",
  ]);

function interpolate(template: string, vars: Vars): string {
  return template.replace(VAR_RE, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`Variável {{${name}}} sem valor (use --set ${name}=...)`);
    return v;
  });
}

/** Troca a origem das URLs gravadas quando `--base-url` aponta para outro host. */
export function rebase(url: string, recordedOrigin: string, baseUrl: string): string {
  const u = new URL(url);
  if (u.origin !== recordedOrigin) return url;
  const base = new URL(baseUrl);
  return new URL(u.pathname + u.search + u.hash, base.origin).toString();
}

/**
 * Acha o elemento testando o seletor principal e as alternativas, em ciclos,
 * até o timeout. Prefere um match único e visível.
 */
async function locate(ctx: Ctx, t: Target, timeout: number): Promise<Locator> {
  const selectors = [t.selector, ...(t.fallbacks ?? [])];
  const deadline = Date.now() + timeout;
  do {
    for (const [i, sel] of selectors.entries()) {
      const loc = ctx.page.locator(sel);
      const n = await loc.count().catch(() => 0);
      if (n === 0) continue;
      const first = loc.first();
      if (n > 1 && !(await first.isVisible().catch(() => false))) continue;
      if (i > 0) ctx.log(`  (seletor alternativo) ${sel}`);
      return first;
    }
    await ctx.page.waitForTimeout(200);
  } while (Date.now() < deadline);
  throw new Error(`Elemento não encontrado: ${t.hint ? `"${t.hint}" ` : ""}(${selectors.join(" | ")})`);
}

function wrapWithCaptcha(step: Step<Vars>, guard: CaptchaGuard | undefined): Step<Vars> {
  if (!guard) return step;
  return {
    ...step,
    async run(ctx) {
      // Verifica ANTES do passo (CAPTCHA pode ter aparecido na página).
      await guard.check(ctx.page);
      try {
        await step.run(ctx);
      } catch (err) {
        // Se o passo falhou, pode ser que um CAPTCHA tenha aparecido enquanto
        // ele esperava (ex.: botão desabilitado pelo widget). Tenta resolver e
        // repetir UMA vez.
        const solved = await guard.check(ctx.page);
        if (!solved) throw err;
        ctx.log(`  (retentando "${step.name}" após CAPTCHA)`);
        await step.run(ctx);
      }
    },
  };
}

function toStep(step: RecordedStep, index: number, rec: Recording, timeout: number): Step<Vars> {
  const origin = new URL(rec.startUrl).origin;
  const url = (u: string, ctx: Ctx) => rebase(u, origin, ctx.config.baseUrl);
  const secret = sensitiveVars(rec);
  const show = (template: string, value: string) =>
    [...template.matchAll(VAR_RE)].some((m) => secret.has(m[1])) ? "••••••" : JSON.stringify(value);

  const name = `#${index + 1} ${describeStep(step)}`;
  switch (step.type) {
    case "goto":
      return {
        name,
        run: async (ctx) => {
          await ctx.page.goto(url(step.url, ctx), { waitUntil: "domcontentloaded", timeout: timeout * 2 });
        },
      };
    case "waitForUrl":
      return {
        name,
        run: async (ctx) => {
          const want = new URL(url(step.url, ctx));
          await ctx.page.waitForURL((u) => u.origin === want.origin && u.pathname === want.pathname, {
            timeout,
            waitUntil: "domcontentloaded",
          });
        },
      };
    case "click":
      return { name, run: async (ctx) => (await locate(ctx, step, timeout)).click({ timeout }) };
    case "waitVisible":
      return {
        name,
        run: async (ctx) => (await locate(ctx, step, timeout)).waitFor({ state: "visible", timeout }),
      };
    case "fill":
      return {
        name,
        run: async (ctx) => {
          const value = interpolate(step.value, ctx.input);
          await (await locate(ctx, step, timeout)).fill(value, { timeout });
          ctx.log(`  ← ${show(step.value, value)}`);
        },
      };
    case "select":
      return {
        name,
        run: async (ctx) => {
          await (await locate(ctx, step, timeout)).selectOption(interpolate(step.value, ctx.input), { timeout });
        },
      };
    case "check":
      return {
        name,
        run: async (ctx) => (await locate(ctx, step, timeout)).setChecked(step.checked, { timeout }),
      };
    case "press":
      return { name, run: async (ctx) => (await locate(ctx, step, timeout)).press(step.key, { timeout }) };
    case "readValue":
      return {
        name,
        async run(ctx) {
          const el = await locate(ctx, step, timeout);
          let value: string;
          const tag = await el.evaluate((e) => e.tagName.toLowerCase());
          if (tag === "input" || tag === "textarea" || tag === "select") {
            value = await el.inputValue();
          } else {
            value = (await el.innerText()).trim();
          }
          if (!value) throw new Error(`Elemento ${step.hint ?? step.selector} está vazio`);
          const key = `read.${step.saveAs}`;
          ctx.input[key] = value;
          ctx.log(`  → {{read.${step.saveAs}}} = ${JSON.stringify(value)}`);
        },
      };
    case "callApi":
      return {
        name,
        async run(ctx) {
          const resolvedUrl = interpolate(step.url, ctx.input);
          const headers: Record<string, string> = {};
          if (step.headers) {
            for (const [k, v] of Object.entries(step.headers)) headers[k] = interpolate(v, ctx.input);
          }
          const body = step.body ? interpolate(step.body, ctx.input) : undefined;
          const method = step.method ?? "GET";

          ctx.log(`  → ${method} ${resolvedUrl}`);
          const res = await fetch(resolvedUrl, {
            method,
            headers: { "Content-Type": "application/json", ...headers },
            body: method !== "GET" ? body : undefined,
            signal: AbortSignal.timeout(timeout * 2),
          });

          let resBody: unknown;
          const text = await res.text();
          try { resBody = JSON.parse(text); } catch { resBody = text; }

          const result = { status: res.status, body: resBody };
          ctx.state[step.saveAs ?? "apiResponse"] = result;
          ctx.log(`  HTTP ${res.status}`);

          if ((step.expect2xx ?? true) && (res.status < 200 || res.status >= 300)) {
            throw new Error(`API retornou ${res.status}: ${typeof resBody === "string" ? resBody.slice(0, 200) : JSON.stringify(resBody).slice(0, 200)}`);
          }

          // Extrai campos da resposta e salva como variáveis {{api.*}}
          if (step.extract && resBody && typeof resBody === "object") {
            for (const [varName, path] of Object.entries(step.extract)) {
              const value = resolvePath(resBody as Record<string, unknown>, path);
              if (value === undefined) {
                throw new Error(`Campo "${path}" não encontrado na resposta da API`);
              }
              const key = `api.${varName}`;
              ctx.input[key] = String(value);
              ctx.log(`  → {{${key}}} = ${JSON.stringify(String(value))}`);
            }
          }
        },
      };
  }
}

/** Converte uma gravação num workflow executável pelo `runWorkflow()`. */
export function recordingToWorkflow(
  rec: Recording,
  opts: ToWorkflowOptions = {},
  captchaGuard?: CaptchaGuard,
): WorkflowDefinition<Vars, unknown> {
  const from = opts.from ?? 0;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  if (from < 0 || from >= rec.steps.length) {
    throw new Error(`Passo inicial ${from + 1} fora do intervalo (a gravação tem ${rec.steps.length} passos)`);
  }
  const remaining = rec.steps.slice(from);
  const needed = variablesUsed(remaining);
  const origin = new URL(rec.startUrl).origin;

  const steps: Step<Vars>[] = remaining.map((s, i) => wrapWithCaptcha(toStep(s, from + i, rec, timeout), captchaGuard));
  if (opts.resumeUrl) {
    const resumeUrl = opts.resumeUrl;
    steps.unshift({
      name: `retomar em ${resumeUrl}`,
      run: async (ctx) => {
        await ctx.page.goto(rebase(resumeUrl, origin, ctx.config.baseUrl), { waitUntil: "domcontentloaded" });
      },
    });
  }

  return defineWorkflow<Vars, unknown>({
    name: rec.name,
    description: rec.description,
    defaults: { baseUrl: origin },
    buildInput(overrides) {
      const input: Vars = {};
      for (const [k, v] of Object.entries(rec.variables)) if (v !== null) input[k] = v;
      for (const [k, v] of Object.entries(overrides)) if (v !== undefined) input[k] = String(v);
      // Valores aleatórios (Alt+G): um conjunto novo por execução; --set fixa um deles.
      if (needed.some(isGeneratorVar)) {
        for (const [k, v] of Object.entries(generateValues())) input[k] ??= v;
      }
      // Variáveis {{read.*}} são preenchidas no runtime pelo passo readValue.
      const missing = needed.filter((n) => input[n] === undefined && !n.startsWith("read.") && !n.startsWith("api."));
      if (missing.length) {
        throw new Error(
          `Faltam valores para: ${missing.join(", ")} — passe com ${missing.map((m) => `--set ${m}=...`).join(" ")}`,
        );
      }
      return input;
    },
    steps,
    result: (ctx) => {
      const generated = Object.fromEntries(
        needed.filter(isGeneratorVar).map((k) => [k.slice(4), ctx.input[k]]),
      );
      return { generated, _input: ctx.input, _state: ctx.state };
    },
  });
}

/**
 * Ponto de retomada para uma falha no passo `failed`: logo depois da última
 * navegação anterior a ele (uma navegação que falhou não conta — a ação que
 * deveria causá-la precisa ser refeita).
 */
export function resumePoint(steps: RecordedStep[], failed: number): { nextStep: number; url?: string } {
  for (let i = failed - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === "goto" || s.type === "waitForUrl") return { nextStep: i + 1, url: s.url };
  }
  return { nextStep: 0 };
}

export interface ReplayOptions {
  /** Começa a partir deste passo (1-based, como mostrado em `show`). */
  fromStep?: number;
  /** Continua do último checkpoint (passo que falhou + cookies + URL). */
  resume?: boolean;
  input?: Record<string, unknown>;
  baseUrl?: string;
  browser?: BrowserOptions;
  timeout?: number;
  outputDir?: string;
  recordingsDir?: string;
  logger?: (msg: string) => void;
  /** Resolver CAPTCHAs automaticamente (precisa de CAPTCHA_SOLVER_API_KEY). */
  captcha?: boolean | CaptchaGuardOptions;
}

export interface ReplayResult extends RunResult<unknown> {
  /** Caminho do checkpoint salvo quando o replay falhou. */
  checkpoint?: string;
  /** Passo (1-based) onde parou, quando falhou. */
  failedStep?: number;
  /** Caminho do arquivo de contas, quando uma conta foi salva. */
  accountFile?: string;
}

export async function replayRecording(rec: Recording, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const dir = opts.recordingsDir ?? DEFAULT_DIR;
  const log = opts.logger ?? ((m: string) => console.log(m));
  let from = opts.fromStep ? opts.fromStep - 1 : 0;
  let resumeUrl: string | undefined;
  let storageState: unknown;

  if (opts.resume) {
    const cp = await loadCheckpoint(rec.name, dir);
    if (!cp) throw new Error(`Nenhum checkpoint para "${rec.name}" — nada para continuar`);
    from = cp.nextStep;
    resumeUrl = cp.url && /^https?:/i.test(cp.url) ? cp.url : undefined;
    storageState = cp.storageState;
    log(`↻ continuando "${rec.name}" do passo ${from + 1} (falhou no ${cp.failedStep + 1}; reabrindo ${cp.url || "início"})`);
  }

  // Guard de CAPTCHA: ativado por padrão quando a API key existe.
  let captchaGuard: CaptchaGuard | undefined;
  if (opts.captcha !== false) {
    const guardOpts: CaptchaGuardOptions = typeof opts.captcha === "object" ? opts.captcha : {};
    guardOpts.logger ??= log;
    const guard = new CaptchaGuard(guardOpts);
    if (guard.configured || opts.captcha === true) captchaGuard = guard;
  }

  const workflow = recordingToWorkflow(rec, { from, resumeUrl, timeout: opts.timeout }, captchaGuard);
  const offset = from - (resumeUrl ? 1 : 0); // passo extra "retomar em" no início
  let checkpointPath: string | undefined;
  let failedIndex: number | undefined;

  const result: ReplayResult = await runWorkflow(workflow, {
    config: opts.baseUrl ? { baseUrl: opts.baseUrl } : {},
    input: opts.input as Partial<Vars>,
    browser: { ...opts.browser, ...(storageState ? { storageState: storageState as object } : {}) },
    outputDir: opts.outputDir,
    logger: log,
    async beforeClose(session, run) {
      if (run.ok) return;
      const failedAt = run.steps.findIndex((s) => !s.ok);
      // Falha no passo "retomar em" → recomeça do mesmo ponto.
      failedIndex = Math.max(from, offset + (failedAt === -1 ? run.steps.length : failedAt));
      const point = resumePoint(rec.steps, failedIndex);
      checkpointPath = await saveCheckpoint(
        {
          recording: rec.name,
          failedStep: failedIndex,
          nextStep: point.nextStep,
          url: point.url ?? "",
          storageState: await session.context.storageState(),
          error: run.error,
          savedAt: new Date().toISOString(),
        },
        dir,
      );
    },
  });

  if (captchaGuard?.solved) log(`  🔒 ${captchaGuard.solved} CAPTCHA(s) resolvido(s) automaticamente`);
  if (result.ok) {
    await clearCheckpoint(rec.name, dir);
    // Salva a conta criada
    const out = result.output as { generated: Record<string, string>; _input: Record<string, string>; _state: Record<string, unknown> } | undefined;
    if (out?._input) {
      const saved = await saveAccount(rec, out._input, result.runId, dir).catch(() => undefined);
      if (saved) {
        const mask = (s: string) => s.slice(0, 2) + "•".repeat(Math.max(0, s.length - 2));
        log(`  📋 conta salva: ${saved.account.identifier} / ${mask(saved.account.password)}`);
        log(`     → ${saved.file}`);
        (result as ReplayResult).accountFile = saved.file;
      }
    }
    // Limpa internos do output
    if (out) {
      const { _input: _, _state: __, ...clean } = out;
      // Inclui respostas de API capturadas
      const apiResults: Record<string, unknown> = {};
      if (__) {
        for (const [k, v] of Object.entries(__)) {
          if (v && typeof v === "object" && "status" in v) apiResults[k] = v;
        }
      }
      (result as RunResult<unknown>).output = { ...clean, ...(Object.keys(apiResults).length ? { api: apiResults } : {}) };
    }
  } else {
    result.checkpoint = checkpointPath;
    result.failedStep = failedIndex !== undefined ? failedIndex + 1 : undefined;
  }
  return result;
}

/** Resolve um caminho como `"data.sms.code"` ou `"items.0.token"` num objeto. */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
