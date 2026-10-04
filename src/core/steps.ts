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

/** Executa `step` apenas se `condition` for verdadeira. */
export const when = <I = any>(
  condition: (ctx: WorkflowContext<I>) => boolean | Promise<boolean>,
  step: Step<I>,
): Step<I> => ({
  name: `when → ${step.name}`,
  async run(ctx) {
    if (await condition(ctx)) await step.run(ctx);
    else ctx.log(`  ${step.name} — condição falsa, pulando`);
  },
});

/**
 * Resolve reCAPTCHA v2 via serviço externo (2Captcha/CapSolver/Anti-Captcha).
 * Extrai a sitekey do widget na página, envia para o solver, e injeta o token
 * no campo `g-recaptcha-response`. Fallback para resolução manual se o solver
 * não estiver configurado.
 *
 * @param responseSelector  Seletor do textarea de resposta do reCAPTCHA
 *                          (padrão: '[name="g-recaptcha-response"]')
 * @param opts.manualTimeout  Timeout para fallback manual, em ms (padrão: 120 000)
 */
export const solveCaptcha = (
  responseSelector = '[name="g-recaptcha-response"]',
  opts: { manualTimeout?: number } = {},
): Step => ({
  name: "resolver CAPTCHA",
  async run(ctx) {
    // Importação dinâmica: evita carregar o módulo quando ninguém usa o step.
    const { captchaSolverFromEnvironment, solveRecaptchaV2 } = await import(
      "../integrations/captcha-solver.js"
    );
    const solver = captchaSolverFromEnvironment(process.env);

    if (!solver) {
      ctx.log("Solver não configurado — aguardando resolução manual.");
      ctx.log("Conclua a verificação no navegador (use --headed).");
      await ctx.page.waitForFunction(
        (sel: string) => {
          const field = document.querySelector<HTMLTextAreaElement>(sel);
          return Boolean(field?.value);
        },
        responseSelector,
        { timeout: opts.manualTimeout ?? 120_000 },
      );
      return;
    }

    ctx.log(`Usando solver: ${solver.service}`);

    // Extrair sitekey do widget na página
    const siteKey = await ctx.page.evaluate(() => {
      const widget = document.querySelector<HTMLElement>(".g-recaptcha, [data-sitekey]");
      return widget?.getAttribute("data-sitekey") ?? null;
    });
    if (!siteKey) {
      // Tenta extrair de um iframe do reCAPTCHA
      const frameSiteKey = await ctx.page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[src*="recaptcha"]');
        if (!frame?.src) return null;
        const match = frame.src.match(/[?&]k=([^&]+)/);
        return match?.[1] ?? null;
      });
      if (!frameSiteKey) throw new Error("Não foi possível extrair a sitekey do reCAPTCHA na página");
      return await solveAndInject(ctx, solver, frameSiteKey, responseSelector);
    }

    await solveAndInject(ctx, solver, siteKey, responseSelector);
  },
});

async function solveAndInject(
  ctx: WorkflowContext<any>,
  solver: import("../integrations/captcha-solver.js").CaptchaSolverConfig,
  siteKey: string,
  responseSelector: string,
): Promise<void> {
  const { solveRecaptchaV2 } = await import("../integrations/captcha-solver.js");
  const pageUrl = ctx.page.url();
  ctx.log(`  siteKey: ${siteKey.slice(0, 8)}…`);
  ctx.log(`  pageUrl: ${pageUrl}`);

  const result = await solveRecaptchaV2(solver, { siteKey, pageUrl });
  if (!result.ok || !result.token) {
    throw new Error(`Solver falhou: ${result.error ?? "sem token"}`);
  }

  ctx.log("  Token recebido, injetando na página…");

  // Injetar o token no textarea e disparar o callback do reCAPTCHA
  await ctx.page.evaluate(
    ({ selector, token }: { selector: string; token: string }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(selector);
      if (textarea) {
        textarea.value = token;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      // Chamar o callback registrado pelo widget para habilitar o submit
      if (typeof window !== "undefined" && (window as any).___grecaptcha_cfg?.clients) {
        for (const client of Object.values((window as any).___grecaptcha_cfg.clients) as any[]) {
          for (const comp of Object.values(client) as any[]) {
            if (comp && typeof comp === "object") {
              for (const val of Object.values(comp) as any[]) {
                if (val && typeof val === "object" && typeof val.callback === "function") {
                  try { val.callback(token); } catch { /* ignora */ }
                }
              }
            }
          }
        }
      }
    },
    { selector: responseSelector, token: result.token },
  );

  ctx.log("  CAPTCHA resolvido.");
}
