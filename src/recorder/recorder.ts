/**
 * Gravador: abre o navegador visível, captura o que você faz e salva em
 * `recordings/<nome>.json` (incrementalmente, a cada passo).
 *
 * A gravação termina quando você fecha a janela, aperta Ctrl+C no terminal,
 * ou — em testes — quando a função `drive` termina.
 */

import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { openSession } from "../core/browser.js";
import type { BrowserOptions, WorkflowContext } from "../core/types.js";
import { describeStep, newRecording, RecordingBuilder } from "./builder.js";
import { EVENT_ROUTE, RECORDER_SCRIPT } from "./inject.js";
import { isGeneratorVar } from "./generators.js";
import { recordingToWorkflow, variablesUsed } from "./replay.js";
import { assertValidName, DEFAULT_DIR, loadRecording, saveRecording } from "./store.js";
import type { PageEvent, Recording } from "./types.js";

export interface RecordOptions {
  name: string;
  /** Página inicial (obrigatória ao criar uma gravação nova). */
  url?: string;
  description?: string;
  /** Reexecuta a gravação existente e continua gravando a partir do fim dela. */
  append?: boolean;
  /** Sobrescreve uma gravação existente com o mesmo nome. */
  force?: boolean;
  /** Valores das variáveis para o replay do `append` (ex.: senhas). */
  input?: Record<string, unknown>;
  browser?: BrowserOptions;
  recordingsDir?: string;
  logger?: (msg: string) => void;
  /** Automação da gravação (testes). Ao terminar, a gravação é encerrada. */
  drive?: (page: Page) => Promise<void>;
}

export interface RecordResult {
  recording: Recording;
  file: string;
}

export async function recordSession(opts: RecordOptions): Promise<RecordResult> {
  assertValidName(opts.name);
  const dir = opts.recordingsDir ?? DEFAULT_DIR;
  const log = opts.logger ?? ((m: string) => console.log(m));

  const existing = await loadRecording(opts.name, dir);
  let rec: Recording;
  if (opts.append) {
    if (!existing) throw new Error(`Gravação "${opts.name}" não existe — grave primeiro sem --append`);
    rec = existing;
  } else {
    if (existing && !opts.force) {
      throw new Error(`Gravação "${opts.name}" já existe — use --append para continuar ou --force para sobrescrever`);
    }
    if (!opts.url) throw new Error("Informe a página inicial com --url");
    rec = newRecording(opts.name, normalizeUrl(opts.url), opts.description);
  }

  const builder = new RecordingBuilder(rec);
  const session = await openSession({ ...opts.browser, headless: opts.browser?.headless ?? false });
  const { context, page } = session;
  let recording = false;

  // ---- salvamento incremental ----
  let file = path.join(dir, `${rec.name}.json`);
  let saveTimer: NodeJS.Timeout | undefined;
  let saving: Promise<unknown> = Promise.resolve();
  const saveNow = () => (saving = saving.then(() => saveRecording(builder.snapshot(), dir)).then((f) => (file = f as string)));
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow().catch((e) => log(`  (erro ao salvar) ${e.message}`)), 300);
  };

  const track = (fn: () => void) => {
    const before = builder.steps.length;
    fn();
    if (builder.steps.length > before) log(`  + #${builder.steps.length} ${describeStep(builder.steps.at(-1)!)}`);
    scheduleSave();
  };

  // Eventos da página e navegações chegam por caminhos diferentes (e fora de
  // ordem). Ficam num buffer curto e são aplicados em ordem de horário.
  const REORDER_MS = 500;
  let pending: { at: number; order: number; apply: (at: number) => void }[] = [];
  let order = 0;
  const enqueue = (at: number, apply: (at: number) => void) => pending.push({ at, order: order++, apply });
  const flush = (all = false) => {
    const limit = Date.now() - REORDER_MS;
    pending.sort((a, b) => a.at - b.at || a.order - b.order);
    const ready = all ? pending : pending.filter((p) => p.at <= limit);
    pending = all ? [] : pending.filter((p) => p.at > limit);
    for (const p of ready) track(() => p.apply(p.at));
  };
  const flusher = setInterval(() => flush(), 100);

  // Canal 1: beacons interceptados (não saem para a rede).
  const seen = new Set<string>();
  const accept = (ev: PageEvent) => {
    if (!recording || !ev?.kind) return;
    if (ev.id) {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
    }
    const arrived = Date.now();
    // Usa o horário da página, salvo se parecer fora de sincronia.
    const at = typeof ev.at === "number" && Math.abs(arrived - ev.at) < 5_000 ? ev.at : arrived;
    enqueue(at, (t) => {
      if (ev.kind === "undo") {
        const removed = builder.undoLast();
        if (removed.length) {
          log(`  ↩ removido: ${removed.map(describeStep).join(" + ")}`);
        } else {
          log("  ↩ nenhum passo para remover");
        }
        return;
      }
      const step = builder.addPageEvent(ev, t);
      if (ev.kind === "generate" && step) void fillGenerated(ev.selector, ev.gen);
      if (ev.kind === "markAccount") {
        const label = ev.role === "identifier" ? "login/e-mail da conta" : "senha da conta";
        log(`  🏷 campo marcado como ${label}`);
      }
      if (ev.kind === "captureValue") {
        log(`    (capturado: {{read.${ev.saveAs}}} = ${JSON.stringify(ev.value.length > 50 ? ev.value.slice(0, 47) + "..." : ev.value)})`);
      }
    });
  };
  // Alt+G: coloca já no campo o valor aleatório desta sessão.
  const fillGenerated = async (selector: string, gen: string) => {
    const value = builder.generated[`gen.${gen}` as keyof typeof builder.generated];
    try {
      await page.locator(selector).first().fill(value);
      log(`    (aleatório: ${/password/i.test(gen) ? "••••••" : value} — muda a cada execução)`);
    } catch (err) {
      log(`  ! não consegui preencher ${selector}: ${(err as Error).message.split("\n")[0]}`);
    }
  };
  await context.route(EVENT_ROUTE, async (route) => {
    const req = route.request();
    let fromOurPage = true;
    try {
      fromOurPage = req.frame().page() === page;
    } catch {
      /* beacon sem frame associado: aceita */
    }
    try {
      if (fromOurPage) accept(JSON.parse(req.postData() ?? "null"));
    } catch {
      /* corpo inválido: ignora */
    }
    await route.fulfill({ status: 204 }).catch(() => {});
  });
  // Canal 2: fila na página, lida periodicamente (reserva p/ CSP restritiva).
  const drain = async () => {
    if (page.isClosed()) return;
    const events = (await page.evaluate("window.__awDrain ? window.__awDrain() : []").catch(() => [])) as PageEvent[];
    for (const ev of events) accept(ev);
  };
  const poller = setInterval(() => void drain(), 400);

  await context.addInitScript(RECORDER_SCRIPT);
  page.on("framenavigated", (frame) => {
    if (!recording || frame !== page.mainFrame()) return;
    const url = frame.url();
    enqueue(Date.now(), (t) => builder.addNavigation(url, t));
  });
  context.on("page", (p) => {
    if (p !== page) log("  ! nova aba/janela aberta — ações nela NÃO são gravadas (use a aba original)");
  });

  try {
    if (opts.append) {
      await replayForAppend(rec, page, opts, log, dir);
      log(`● continuando a gravação "${rec.name}" a partir do passo ${rec.steps.length + 1}`);
    } else {
      log(`● gravando "${rec.name}" — faça o fluxo no navegador; feche a janela (ou Ctrl+C) para salvar`);
      log("  dica: Alt+Z = desfazer · Alt+S = capturar valor · Alt+G = aleatório · Alt+M = login/senha · Alt+clique = verificação");
    }
    if (opts.append) {
      // Descarta os eventos gerados pelo próprio replay antes de começar a gravar.
      await page.waitForTimeout(500).catch(() => {});
      await drain();
    }
    recording = true;
    if (!opts.append) await page.goto(rec.startUrl, { waitUntil: "domcontentloaded" });

    await waitForEnd(page, opts.drive);
    // Deixa chegar os últimos eventos da página antes de encerrar.
    if (!page.isClosed()) {
      await page.waitForTimeout(600).catch(() => {});
      await drain();
    } else {
      await new Promise((r) => setTimeout(r, 600));
    }
  } finally {
    clearInterval(poller);
    clearInterval(flusher);
    flush(true);
    recording = false;
    clearTimeout(saveTimer);
    await saving.catch(() => {});
    await saveNow();
    await session.close();
  }

  const final = builder.snapshot();
  log(`✔ ${final.steps.length} passos salvos em ${file}`);
  const secrets = Object.entries(final.variables).filter(([, v]) => v === null).map(([k]) => k);
  const gens = variablesUsed(final.steps).filter(isGeneratorVar);
  if (gens.length) log(`  valores aleatórios a cada execução: ${gens.join(", ")}`);
  if (final.accountFields?.identifier || final.accountFields?.password) {
    log(`  campos da conta: login={{${final.accountFields.identifier ?? "?"}}} senha={{${final.accountFields.password ?? "?"}}}`);
  }
  if (secrets.length) log(`  senhas não são salvas — no replay use: ${secrets.map((s) => `--set ${s}=...`).join(" ")}`);
  return { recording: final, file };
}

/** Reexecuta os passos já gravados (sem gravar) para chegar ao ponto onde parou. */
async function replayForAppend(
  rec: Recording,
  page: Page,
  opts: RecordOptions,
  log: (m: string) => void,
  dir: string,
): Promise<void> {
  if (!rec.steps.length) {
    await page.goto(rec.startUrl, { waitUntil: "domcontentloaded" });
    return;
  }
  const wf = recordingToWorkflow(rec);
  const ctx: WorkflowContext<Record<string, string>> = {
    page,
    input: wf.buildInput((opts.input ?? {}) as Record<string, string>, wf.defaults),
    config: wf.defaults,
    state: {},
    log: (m) => log(`  ${m}`),
  };
  log(`↻ reexecutando ${rec.steps.length} passos gravados…`);
  for (const [i, step] of wf.steps.entries()) {
    log(`• ${step.name}`);
    try {
      await step.run(ctx);
    } catch (err) {
      // Guarda o original e corta a gravação no passo que quebrou:
      // você refaz manualmente a partir dali e o resto é regravado.
      const backup = path.join(dir, `${rec.name}.json.bak`);
      await copyFile(path.join(dir, `${rec.name}.json`), backup).catch(() => {});
      rec.steps.splice(i);
      log(`  ✖ ${(err as Error).message}`);
      log(`  a gravação foi cortada no passo ${i + 1} (original em ${backup}); continue manualmente a partir daqui`);
      return;
    }
  }
}

function waitForEnd(page: Page, drive?: (page: Page) => Promise<void>): Promise<void> {
  if (drive) return drive(page);
  return new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      resolve();
    };
    page.once("close", done);
    page.context().browser()?.once("disconnected", done);
    process.once("SIGINT", done);
  });
}

function normalizeUrl(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  return new URL(withScheme).toString();
}
