/**
 * Guard de CAPTCHA para o replay: antes de cada passo (e quando um falha),
 * verifica se apareceu um CAPTCHA na página e resolve automaticamente,
 * sem precisar estar gravado como passo.
 *
 * Suporta:
 *  - reCAPTCHA v2 (checkbox / invisible)
 *  - hCaptcha
 *  - Cloudflare Turnstile
 *
 * Requer `CAPTCHA_SOLVER_API_KEY` configurada; sem ela, avisa e continua.
 */

import type { Page } from "playwright-core";
import {
  captchaSolverFromEnvironment,
  solveRecaptchaV2,
  type CaptchaSolverConfig,
  type SolveResult,
} from "../integrations/captcha-solver.js";

export interface CaptchaGuardOptions {
  /** Solver já configurado (default: `captchaSolverFromEnvironment(process.env)`). */
  solver?: CaptchaSolverConfig;
  /** Timeout para cada tentativa de resolução (ms). */
  timeout?: number;
  /** Espera (ms) para o CAPTCHA aparecer completamente antes de detectar. */
  settleMs?: number;
  logger?: (msg: string) => void;
}

interface Detected {
  kind: "recaptcha-v2" | "hcaptcha" | "turnstile";
  siteKey: string;
  responseSelector: string;
}

// ---------------------------------------------------------------------------
// Detecção
// ---------------------------------------------------------------------------

/** Procura widgets de CAPTCHA visíveis na página. */
async function detect(page: Page): Promise<Detected | undefined> {
  return page.evaluate(() => {
    // reCAPTCHA v2
    const rc =
      document.querySelector<HTMLElement>(".g-recaptcha[data-sitekey]") ??
      document.querySelector<HTMLElement>("[data-sitekey]");
    if (rc) {
      const key = rc.getAttribute("data-sitekey");
      if (key) return { kind: "recaptcha-v2" as const, siteKey: key, responseSelector: '[name="g-recaptcha-response"]' };
    }
    const rcFrame = document.querySelector<HTMLIFrameElement>('iframe[src*="recaptcha"]');
    if (rcFrame?.src) {
      const m = rcFrame.src.match(/[?&]k=([^&]+)/);
      if (m) return { kind: "recaptcha-v2" as const, siteKey: m[1], responseSelector: '[name="g-recaptcha-response"]' };
    }

    // hCaptcha
    const hc = document.querySelector<HTMLElement>(".h-captcha[data-sitekey]");
    if (hc) {
      const key = hc.getAttribute("data-sitekey");
      if (key) return { kind: "hcaptcha" as const, siteKey: key, responseSelector: '[name="h-captcha-response"]' };
    }
    const hcFrame = document.querySelector<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]');
    if (hcFrame?.src) {
      const m = hcFrame.src.match(/[?&]sitekey=([^&]+)/);
      if (m) return { kind: "hcaptcha" as const, siteKey: m[1], responseSelector: '[name="h-captcha-response"]' };
    }

    // Cloudflare Turnstile
    const ts = document.querySelector<HTMLElement>(".cf-turnstile[data-sitekey]");
    if (ts) {
      const key = ts.getAttribute("data-sitekey");
      if (key) return { kind: "turnstile" as const, siteKey: key, responseSelector: '[name="cf-turnstile-response"]' };
    }
    const tsInput = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
    if (tsInput) {
      const widget = tsInput.closest<HTMLElement>("[data-sitekey]");
      const key = widget?.getAttribute("data-sitekey");
      if (key) return { kind: "turnstile" as const, siteKey: key, responseSelector: '[name="cf-turnstile-response"]' };
    }

    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Resolução
// ---------------------------------------------------------------------------

const METHOD: Record<Detected["kind"], string> = {
  "recaptcha-v2": "userrecaptcha",
  hcaptcha: "hcaptcha",
  turnstile: "turnstile",
};

async function solve(solver: CaptchaSolverConfig, captcha: Detected, pageUrl: string): Promise<SolveResult> {
  // A API do 2Captcha (e compatíveis) resolve os três tipos com o mesmo fluxo;
  // o que muda é o `method` no envio. A função solveRecaptchaV2 já encapsula
  // submit → poll → token. Para hCaptcha e Turnstile, mandamos o parâmetro certo.
  //
  // Para manter compatibilidade sem duplicar código, fazemos um fetch customizado
  // que injeta o method correto.
  if (captcha.kind === "recaptcha-v2") {
    return solveRecaptchaV2(solver, { siteKey: captcha.siteKey, pageUrl });
  }

  // hCaptcha e Turnstile: mesma API, method diferente.
  const submitUrl = new URL("/in.php", solver.apiUrl);
  const submitParams = new URLSearchParams({
    key: solver.apiKey,
    method: METHOD[captcha.kind],
    sitekey: captcha.siteKey,
    pageurl: pageUrl,
    json: "1",
  });

  let taskId: string;
  try {
    const res = await fetch(submitUrl, {
      method: "POST",
      body: submitParams,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ao enviar tarefa` };
    const data = (await res.json()) as { status?: number; request?: string; error_text?: string };
    if (data.status !== 1 || !data.request) {
      return { ok: false, error: data.error_text ?? data.request ?? "Resposta inesperada" };
    }
    taskId = data.request;
  } catch (err) {
    return { ok: false, error: `Falha ao enviar: ${(err as Error).message}` };
  }

  const deadline = Date.now() + solver.timeout;
  const resultUrl = new URL("/res.php", solver.apiUrl);
  const resultParams = new URLSearchParams({ key: solver.apiKey, action: "get", id: taskId, json: "1" });

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, solver.pollInterval));
    try {
      const res = await fetch(`${resultUrl}?${resultParams}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { status?: number; request?: string; error_text?: string };
      if (data.status === 1 && data.request) return { ok: true, token: data.request };
      if (data.request === "CAPCHA_NOT_READY") continue;
      return { ok: false, error: data.error_text ?? data.request ?? "Erro desconhecido" };
    } catch {
      continue;
    }
  }
  return { ok: false, error: "Timeout: serviço não resolveu a tempo" };
}

/** Injeta o token e dispara os callbacks do widget. */
async function inject(page: Page, captcha: Detected, token: string): Promise<void> {
  await page.evaluate(
    ({ selector, token, kind }: { selector: string; token: string; kind: string }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(selector);
      if (textarea) {
        textarea.value = token;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // reCAPTCHA v2: callbacks registrados no widget global
      if (kind === "recaptcha-v2") {
        try {
          const cfg = (window as any).___grecaptcha_cfg;
          if (cfg?.clients) {
            for (const client of Object.values(cfg.clients) as any[]) {
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
        } catch { /* ignora */ }
      }

      // hCaptcha: callback global
      if (kind === "hcaptcha") {
        try {
          const hc = (window as any).hcaptcha;
          if (hc) {
            const ids = hc.getAllResponseIds?.() ?? [];
            for (const id of ids) {
              try { hc.setData?.(id, { response: token }); } catch { /* ignora */ }
            }
          }
        } catch { /* ignora */ }
      }

      // Turnstile: callback global
      if (kind === "turnstile") {
        try {
          const ts = (window as any).turnstile;
          if (ts) {
            const widgets = document.querySelectorAll(".cf-turnstile");
            for (const w of widgets) {
              const id = w.getAttribute("data-widget-id");
              if (id) {
                try { ts.getResponse?.(id); } catch { /* ignora */ }
              }
            }
          }
        } catch { /* ignora */ }
      }
    },
    { selector: captcha.responseSelector, token, kind: captcha.kind },
  );
}

// ---------------------------------------------------------------------------
// Guard público
// ---------------------------------------------------------------------------

export class CaptchaGuard {
  private solver: CaptchaSolverConfig | undefined;
  private settleMs: number;
  private log: (msg: string) => void;
  /** Quantos CAPTCHAs já foram resolvidos nesta execução. */
  solved = 0;

  constructor(opts: CaptchaGuardOptions = {}) {
    this.solver = opts.solver ?? captchaSolverFromEnvironment(process.env);
    this.settleMs = opts.settleMs ?? 800;
    this.log = opts.logger ?? ((m: string) => console.log(m));
  }

  get configured(): boolean {
    return this.solver !== undefined;
  }

  /**
   * Verifica se há um CAPTCHA na página e resolve. Retorna `true` se resolveu
   * um (o passo seguinte pode prosseguir), `false` se não havia, e lança se
   * o solver falhou e o fluxo não pode continuar.
   */
  async check(page: Page): Promise<boolean> {
    if (page.isClosed()) return false;
    // Dá um tempo para o widget terminar de renderizar.
    await page.waitForTimeout(this.settleMs).catch(() => {});

    const captcha = await detect(page).catch(() => undefined);
    if (!captcha) return false;

    // Já foi resolvido (o textarea já tem token)?
    const alreadyDone = await page
      .evaluate((sel) => {
        const el = document.querySelector<HTMLTextAreaElement>(sel);
        return Boolean(el?.value);
      }, captcha.responseSelector)
      .catch(() => false);
    if (alreadyDone) return false;

    this.log(`  🔒 ${captcha.kind} detectado (siteKey ${captcha.siteKey.slice(0, 8)}…)`);

    if (!this.solver) {
      this.log("  ⚠ CAPTCHA_SOLVER_API_KEY não configurada — aguardando resolução manual (use --headed)");
      await page
        .waitForFunction(
          (sel: string) => {
            const el = document.querySelector<HTMLTextAreaElement>(sel);
            return Boolean(el?.value);
          },
          captcha.responseSelector,
          { timeout: 120_000 },
        )
        .catch(() => {
          throw new Error("Timeout aguardando resolução manual do CAPTCHA");
        });
      this.solved++;
      this.log("  ✔ CAPTCHA resolvido manualmente");
      return true;
    }

    this.log(`  → enviando para ${this.solver.service}…`);
    const result = await solve(this.solver, captcha, page.url());
    if (!result.ok || !result.token) {
      throw new Error(`Solver falhou (${captcha.kind}): ${result.error ?? "sem token"}`);
    }

    await inject(page, captcha, result.token);
    this.solved++;
    this.log(`  ✔ ${captcha.kind} resolvido via ${this.solver.service}`);
    return true;
  }
}
