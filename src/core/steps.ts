/**
 * Biblioteca de passos reutilizáveis. Cada fábrica retorna um `Step`;
 * um workflow é só uma lista deles.
 *
 * Valores aceitam `Dynamic<T>`: literal ou `(ctx) => valor`, o que permite
 * referenciar `ctx.input` (dados do cadastro) e `ctx.config` (ex.: baseUrl).
 */

import type { Dynamic, Step, WorkflowContext } from "./types.js";

const resolve = <T>(v: Dynamic<T>, ctx: WorkflowContext<any>): T =>
  typeof v === "function" ? (v as (c: WorkflowContext<any>) => T)(ctx) : v;

type FieldValue = string | number | boolean | undefined;

/** Navega para uma URL (absoluta ou relativa a `config.baseUrl`). */
export const goto = (url: Dynamic<string>, opts: { waitFor?: string } = {}): Step => ({
  name: `goto ${typeof url === "string" ? url : "<dinâmico>"}`,
  async run(ctx) {
    const target = new URL(resolve(url, ctx), ctx.config.baseUrl).toString();
    await ctx.page.goto(target, { waitUntil: "domcontentloaded" });
    if (opts.waitFor) await ctx.page.locator(opts.waitFor).waitFor({ state: "visible" });
  },
});

/**
 * Preenche campos a partir de um mapa `seletor -> valor`. O tipo do campo é
 * detectado (input/select/checkbox/radio), então serve para qualquer formulário.
 * Valores `undefined` são pulados (campos opcionais).
 */
export const fillForm = (fields: Record<string, Dynamic<FieldValue>>): Step => ({
  name: `fillForm (${Object.keys(fields).length} campos)`,
  async run(ctx) {
    for (const [selector, raw] of Object.entries(fields)) {
      const value = resolve(raw, ctx);
      if (value === undefined) continue;
      const el = ctx.page.locator(selector);
      const { tag, type } = await el.evaluate((n) => ({
        tag: n.tagName.toLowerCase(),
        type: (n as HTMLInputElement).type,
      }));

      if (tag === "select") await el.selectOption(String(value));
      else if (type === "checkbox" || type === "radio") await el.setChecked(Boolean(value));
      else await el.fill(String(value));
      ctx.log(`  ${selector} ← ${type === "password" ? "••••••" : JSON.stringify(value)}`);
    }
  },
});

export const click = (selector: string): Step => ({
  name: `click ${selector}`,
  run: (ctx) => ctx.page.locator(selector).click(),
});

/**
 * Clica e captura a resposta HTTP (não-GET) cuja URL contém `urlPart`.
 * Salva `{ status, body }` em `ctx.state[saveAs]`.
 */
export const submitAndCapture = (
  selector: string,
  opts: { urlPart: string; saveAs?: string },
): Step => ({
  name: `submit ${selector} → ${opts.urlPart}`,
  async run(ctx) {
    const [response] = await Promise.all([
      ctx.page.waitForResponse((r) => r.url().includes(opts.urlPart) && r.request().method() !== "GET"),
      ctx.page.locator(selector).click(),
    ]);
    const body = await response.json().catch(() => null);
    ctx.state[opts.saveAs ?? "response"] = { status: response.status(), body };
    ctx.log(`  HTTP ${response.status()}`);
  },
});

export const waitVisible = (selector: string, timeout = 10_000): Step => ({
  name: `waitVisible ${selector}`,
  run: (ctx) => ctx.page.locator(selector).waitFor({ state: "visible", timeout }),
});

/** Lê o texto de um elemento para `ctx.state[saveAs]`. */
export const extractText = (selector: string, saveAs: string): Step => ({
  name: `extractText ${selector} → ${saveAs}`,
  async run(ctx) {
    ctx.state[saveAs] = (await ctx.page.locator(selector).textContent())?.trim();
  },
});

/** Coleta mensagens de erro visíveis em `ctx.state.formErrors`. */
export const collectErrors = (selector: string): Step => ({
  name: `collectErrors ${selector}`,
  async run(ctx) {
    const texts = await ctx.page.locator(selector).allTextContents();
    ctx.state.formErrors = texts.map((t) => t.trim()).filter(Boolean);
  },
});

/** Asserção arbitrária; lança se `predicate(ctx)` for falso. */
export const assert = <I = any>(
  description: string,
  predicate: (ctx: WorkflowContext<I>) => boolean | Promise<boolean>,
): Step<I> => ({
  name: `assert ${description}`,
  async run(ctx) {
    if (!(await predicate(ctx))) throw new Error(`Asserção falhou: ${description}`);
  },
});

/** Passo livre para lógica específica que não cabe nos genéricos. */
export const custom = <I = any>(name: string, run: Step<I>["run"]): Step<I> => ({ name, run });

/** Marca um passo como opcional (falha não interrompe o workflow). */
export const optional = <I>(step: Step<I>): Step<I> => ({ ...step, optional: true });
