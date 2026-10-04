/**
 * Abstração do navegador. O resto do projeto depende só de `openSession()`,
 * então a troca de driver/configuração fica concentrada aqui.
 */

import { launch } from "cloakbrowser";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { BrowserOptions } from "./types.js";

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export async function openSession(opts: BrowserOptions = {}): Promise<Session> {
  const browser = await launch({
    headless: opts.headless ?? true,
    humanize: opts.humanize ?? false,
    locale: opts.locale,
    timezone: opts.timezone,
    launchOptions: opts.slowMo ? { slowMo: opts.slowMo } : undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
