import { describe, expect, it, vi } from "vitest";
import {
  captchaSolverFromEnvironment,
  solveRecaptchaV2,
  type CaptchaSolverConfig,
} from "../src/integrations/captcha-solver.js";

const baseConfig: CaptchaSolverConfig = {
  apiKey: "test-api-key",
  service: "2captcha",
  apiUrl: "https://2captcha.com",
  timeout: 10_000,
  pollInterval: 100,
};

const solveOpts = { siteKey: "6LeIxAcTAAAAAN...", pageUrl: "https://example.com/signup" };

function mockFetch(responses: Array<{ status?: number; body: unknown }>): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Configuração via ambiente
// ---------------------------------------------------------------------------

describe("captchaSolverFromEnvironment", () => {
  it("retorna undefined sem API key", () => {
    expect(captchaSolverFromEnvironment({})).toBeUndefined();
    expect(captchaSolverFromEnvironment({ CAPTCHA_SOLVER_API_KEY: "" })).toBeUndefined();
    expect(captchaSolverFromEnvironment({ CAPTCHA_SOLVER_API_KEY: "  " })).toBeUndefined();
  });

  it("usa 2captcha como serviço padrão", () => {
    const config = captchaSolverFromEnvironment({ CAPTCHA_SOLVER_API_KEY: "key123" });
    expect(config).toMatchObject({ apiKey: "key123", service: "2captcha", apiUrl: "https://2captcha.com" });
  });

  it("aceita serviços conhecidos", () => {
    for (const service of ["2captcha", "capsolver", "anticaptcha"]) {
      const config = captchaSolverFromEnvironment({ CAPTCHA_SOLVER_API_KEY: "k", CAPTCHA_SOLVER_SERVICE: service });
      expect(config?.service).toBe(service);
    }
  });

  it("rejeita serviço desconhecido", () => {
    expect(() => captchaSolverFromEnvironment({ CAPTCHA_SOLVER_API_KEY: "k", CAPTCHA_SOLVER_SERVICE: "unknown" })).toThrow("inválido");
  });

  it("aceita URL customizada e timeouts", () => {
    const config = captchaSolverFromEnvironment({
      CAPTCHA_SOLVER_API_KEY: "k",
      CAPTCHA_SOLVER_API_URL: "https://custom.api.test",
      CAPTCHA_SOLVER_TIMEOUT: "60000",
      CAPTCHA_SOLVER_POLL_INTERVAL: "2000",
    });
    expect(config).toMatchObject({ apiUrl: "https://custom.api.test", timeout: 60_000, pollInterval: 2_000 });
  });
});

// ---------------------------------------------------------------------------
// Resolução reCAPTCHA v2
// ---------------------------------------------------------------------------

describe("solveRecaptchaV2", () => {
  it("envia tarefa e retorna token após polling", async () => {
    const fetcher = mockFetch([
      { body: { status: 1, request: "task-123" } },          // in.php → OK
      { body: { status: 0, request: "CAPCHA_NOT_READY" } },  // res.php → não pronto
      { body: { status: 1, request: "solved-token-abc" } },  // res.php → resolvido
    ]);

    const result = await solveRecaptchaV2(baseConfig, solveOpts, fetcher);
    expect(result).toEqual({ ok: true, token: "solved-token-abc" });
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Verifica que o submit envia os parâmetros corretos
    const [submitUrl, submitOpts] = vi.mocked(fetcher).mock.calls[0];
    expect(submitUrl.toString()).toContain("/in.php");
    const body = submitOpts?.body as URLSearchParams;
    expect(body.get("key")).toBe("test-api-key");
    expect(body.get("method")).toBe("userrecaptcha");
    expect(body.get("googlekey")).toBe(solveOpts.siteKey);
    expect(body.get("pageurl")).toBe(solveOpts.pageUrl);
  });

  it("retorna erro quando o serviço recusa a tarefa", async () => {
    const fetcher = mockFetch([
      { body: { status: 0, request: "ERROR_WRONG_USER_KEY", error_text: "Chave inválida" } },
    ]);

    const result = await solveRecaptchaV2(baseConfig, solveOpts, fetcher);
    expect(result).toEqual({ ok: false, error: "Chave inválida" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retorna erro quando o serviço responde com HTTP não-200 no submit", async () => {
    const fetcher = mockFetch([{ status: 500, body: {} }]);
    const result = await solveRecaptchaV2(baseConfig, solveOpts, fetcher);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });

  it("retorna erro quando o polling encontra erro definitivo", async () => {
    const fetcher = mockFetch([
      { body: { status: 1, request: "task-456" } },
      { body: { status: 0, request: "ERROR_CAPTCHA_UNSOLVABLE", error_text: "Não resolvível" } },
    ]);

    const result = await solveRecaptchaV2(baseConfig, solveOpts, fetcher);
    expect(result).toEqual({ ok: false, error: "Não resolvível" });
  });

  it("retorna timeout quando o serviço nunca resolve", async () => {
    const config = { ...baseConfig, timeout: 300, pollInterval: 50 };
    const fetcher = mockFetch([
      { body: { status: 1, request: "task-789" } },
      { body: { status: 0, request: "CAPCHA_NOT_READY" } },
    ]);

    const result = await solveRecaptchaV2(config, solveOpts, fetcher);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Timeout");
  });

  it("retorna erro em falha de rede no submit", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const result = await solveRecaptchaV2(baseConfig, solveOpts, fetcher);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("continua polling após falha de rede temporária no resultado", async () => {
    let call = 0;
    const fetcher = vi.fn(async (url: string | URL) => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ status: 1, request: "task-net" }));    // submit
      if (call === 2) throw new Error("rede caiu");                                                // polling falha
      return new Response(JSON.stringify({ status: 1, request: "token-after-retry" }));            // polling OK
    }) as unknown as typeof fetch;

    const result = await solveRecaptchaV2(baseConfig, solveOpts, fetcher);
    expect(result).toEqual({ ok: true, token: "token-after-retry" });
  });

  it("não expõe a API key em erros", async () => {
    const fetcher = mockFetch([{ status: 403, body: { error: "forbidden" } }]);
    const result = await solveRecaptchaV2(baseConfig, solveOpts, fetcher);
    expect(JSON.stringify(result)).not.toContain(baseConfig.apiKey);
  });
});
