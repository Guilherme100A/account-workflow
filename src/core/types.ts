import type { Page } from "playwright-core";

/** Opções repassadas ao `launch()` do CloakBrowser. */
export interface BrowserOptions {
  headless?: boolean;
  /** Gateway da pool; a rotação de IP é controlada pelo provedor. */
  proxy?: { server: string; username?: string; password?: string };
  /** Mouse/teclado com ritmo humano (recurso nativo do CloakBrowser). */
  humanize?: boolean;
  locale?: string;
  timezone?: string;
  /** Atraso (ms) entre ações — útil para depurar com `--headed`. */
  slowMo?: number;
}

export interface WorkflowConfig {
  baseUrl: string;
  [key: string]: unknown;
}

export interface WorkflowContext<I = Record<string, unknown>> {
  page: Page;
  input: I;
  config: WorkflowConfig;
  /** Área compartilhada entre passos (respostas capturadas, textos extraídos…). */
  state: Record<string, unknown>;
  log: (msg: string) => void;
}

export interface Step<I = any> {
  name: string;
  run: (ctx: WorkflowContext<I>) => Promise<unknown> | unknown;
  /** Se true, uma falha é registrada mas não interrompe o workflow. */
  optional?: boolean;
}

export interface WorkflowDefinition<I = any, O = unknown> {
  name: string;
  description: string;
  defaults: WorkflowConfig;
  /** Gera os dados de entrada; `overrides` vem da CLI ou do chamador. */
  buildInput: (overrides: Partial<I>, config: WorkflowConfig) => I;
  steps: Step<I>[];
  /** Monta a saída final a partir do contexto (padrão: `ctx.state`). */
  result?: (ctx: WorkflowContext<I>) => Promise<O> | O;
}

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RunResult<O = unknown> {
  runId: string;
  workflow: string;
  ok: boolean;
  steps: StepResult[];
  startedAt: string;
  finishedAt?: string;
  output?: O;
  error?: string;
  screenshot?: string;
  reportPath?: string;
}

/** Valor literal ou calculado a partir do contexto. */
export type Dynamic<T, I = any> = T | ((ctx: WorkflowContext<I>) => T);
