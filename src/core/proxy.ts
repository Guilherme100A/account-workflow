import type { BrowserOptions } from "./types.js";

/** Credentials stay outside workflow input and reports. No fallback on proxy errors. */
export function proxyFromEnvironment(
  env: Record<string, string | undefined>,
  serverOverride?: string,
): BrowserOptions["proxy"] {
  const raw = serverOverride ?? env.WORKFLOW_PROXY_SERVER;
  if (!raw) {
    if (env.WORKFLOW_PROXY_USERNAME || env.WORKFLOW_PROXY_PASSWORD)
      throw new Error("Configure WORKFLOW_PROXY_SERVER para usar credenciais de proxy");
    return undefined;
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Proxy inválido: use protocolo://host:porta"); }
  if (!["http:", "https:", "socks5:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Proxy inválido: use http, https ou socks5 sem caminho, query ou fragmento");
  let username: string | undefined;
  let password: string | undefined;
  try {
    username = env.WORKFLOW_PROXY_USERNAME ?? (url.username ? decodeURIComponent(url.username) : undefined);
    password = env.WORKFLOW_PROXY_PASSWORD ?? (url.password ? decodeURIComponent(url.password) : undefined);
  } catch { throw new Error("Codificação inválida nas credenciais do proxy"); }
  if (url.protocol === "socks5:" && (username || password))
    throw new Error("SOCKS5 autenticado não é suportado pelo Chromium; use o gateway HTTP do provedor");
  if (password && !username) throw new Error("Informe o usuário do proxy");
  return {
    server: `${url.protocol}//${url.host}`,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}
