/**
 * Cliente para serviços de resolução de CAPTCHA com API compatível com 2Captcha.
 * Compatível com: 2Captcha, Anti-Captcha (via endpoint 2captcha), CapSolver.
 *
 * Uso: configure CAPTCHA_SOLVER_API_KEY (obrigatório) e opcionalmente
 * CAPTCHA_SOLVER_SERVICE (padrão "2captcha") nas variáveis de ambiente.
 *
 * Suporta reCAPTCHA v2 (checkbox). Outros tipos podem ser adicionados.
 */

export interface CaptchaSolverConfig {
  apiKey: string;
  service: CaptchaSolverService;
  /** URL base da API; inferida do serviço quando omitida. */
  apiUrl: string;
  /** Tempo máximo de espera pela solução, em ms (padrão: 180 000). */
  timeout: number;
  /** Intervalo entre consultas de resultado, em ms (padrão: 5 000). */
  pollInterval: number;
}

export type CaptchaSolverService = "2captcha" | "capsolver" | "anticaptcha";

const SERVICE_URLS: Record<CaptchaSolverService, string> = {
  "2captcha": "https://2captcha.com",
  capsolver: "https://api.capsolver.com",
  anticaptcha: "https://2captcha.com", // Anti-Captcha expõe endpoint compatível
};

const KNOWN_SERVICES = new Set<string>(Object.keys(SERVICE_URLS));

export function captchaSolverFromEnvironment(
  env: Record<string, string | undefined>,
): CaptchaSolverConfig | undefined {
  const apiKey = env.CAPTCHA_SOLVER_API_KEY?.trim();
  if (!apiKey) return undefined;

  const raw = (env.CAPTCHA_SOLVER_SERVICE ?? "2captcha").trim().toLowerCase();
  if (!KNOWN_SERVICES.has(raw)) {
    throw new Error(`CAPTCHA_SOLVER_SERVICE inválido: "${raw}" (use: ${[...KNOWN_SERVICES].join(", ")})`);
  }
  const service = raw as CaptchaSolverService;
  const apiUrl = env.CAPTCHA_SOLVER_API_URL?.trim() || SERVICE_URLS[service];
  const timeout = Number(env.CAPTCHA_SOLVER_TIMEOUT) || 180_000;
  const pollInterval = Number(env.CAPTCHA_SOLVER_POLL_INTERVAL) || 5_000;

  return { apiKey, service, apiUrl, timeout, pollInterval };
}

// ---------------------------------------------------------------------------
// Resolução via API compatível com 2Captcha (in.php → res.php)
// ---------------------------------------------------------------------------

export interface SolveRecaptchaV2Options {
  siteKey: string;
  pageUrl: string;
}

export interface SolveResult {
  ok: boolean;
  token?: string;
  error?: string;
}

/**
 * Envia o CAPTCHA para resolução e aguarda o resultado.
 * Não lança exceções em falhas de negócio — devolve `{ ok: false, error }`.
 */
export async function solveRecaptchaV2(
  config: CaptchaSolverConfig,
  options: SolveRecaptchaV2Options,
  fetcher: typeof fetch = fetch,
): Promise<SolveResult> {
  // 1) Enviar tarefa
  const submitUrl = new URL("/in.php", config.apiUrl);
  const submitParams = new URLSearchParams({
    key: config.apiKey,
    method: "userrecaptcha",
    googlekey: options.siteKey,
    pageurl: options.pageUrl,
    json: "1",
  });

  let taskId: string;
  try {
    const res = await fetcher(submitUrl, {
      method: "POST",
      body: submitParams,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ao enviar tarefa` };
    const data = (await res.json()) as { status?: number; request?: string; error_text?: string };
    if (data.status !== 1 || !data.request) {
      return { ok: false, error: data.error_text ?? data.request ?? "Resposta inesperada do serviço" };
    }
    taskId = data.request;
  } catch (err) {
    return { ok: false, error: `Falha ao enviar: ${(err as Error).message}` };
  }

  // 2) Aguardar solução
  const deadline = Date.now() + config.timeout;
  const resultUrl = new URL("/res.php", config.apiUrl);
  const resultParams = new URLSearchParams({
    key: config.apiKey,
    action: "get",
    id: taskId,
    json: "1",
  });

  while (Date.now() < deadline) {
    await sleep(config.pollInterval);

    try {
      const res = await fetcher(`${resultUrl}?${resultParams}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue; // retry na próxima iteração
      const data = (await res.json()) as { status?: number; request?: string; error_text?: string };

      if (data.status === 1 && data.request) {
        return { ok: true, token: data.request };
      }
      // CAPCHA_NOT_READY → continua esperando
      if (data.request === "CAPCHA_NOT_READY") continue;
      // Erro definitivo do serviço
      return { ok: false, error: data.error_text ?? data.request ?? "Erro desconhecido" };
    } catch {
      // Falha de rede temporária — tenta de novo
      continue;
    }
  }

  return { ok: false, error: "Timeout: serviço não resolveu a tempo" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
