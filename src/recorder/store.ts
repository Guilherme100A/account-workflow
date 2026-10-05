/**
 * Persistência das gravações (`recordings/<nome>.json`) e dos checkpoints de
 * replay (`recordings/<nome>.checkpoint.json`, ignorado pelo Git porque guarda
 * cookies da sessão).
 */

import path from "node:path";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Checkpoint, RecordedStep, Recording } from "./types.js";

export const DEFAULT_DIR = process.env.RECORDINGS_DIR ?? "recordings";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Nome de gravação inválido: "${name}" (use letras, números, ".", "_" ou "-")`);
  }
}

const recordingPath = (name: string, dir: string) => path.join(dir, `${name}.json`);
const checkpointPath = (name: string, dir: string) => path.join(dir, `${name}.checkpoint.json`);

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Falha ao ler ${file}: ${(err as Error).message}`);
  }
}

export async function saveRecording(rec: Recording, dir = DEFAULT_DIR): Promise<string> {
  assertValidName(rec.name);
  const file = recordingPath(rec.name, dir);
  await writeJsonAtomic(file, rec);
  return file;
}

export async function loadRecording(name: string, dir = DEFAULT_DIR): Promise<Recording | undefined> {
  assertValidName(name);
  const rec = await readJson<Recording>(recordingPath(name, dir));
  if (rec && (rec.version !== 1 || !Array.isArray(rec.steps))) {
    throw new Error(`Gravação "${name}" em formato desconhecido`);
  }
  return rec;
}

export async function listRecordings(dir = DEFAULT_DIR): Promise<Recording[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: Recording[] = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".json") || f.endsWith(".checkpoint.json")) continue;
    const rec = await readJson<Recording>(path.join(dir, f)).catch(() => undefined);
    if (rec?.version === 1) out.push(rec);
  }
  return out;
}

/** Remove um passo pelo número exibido em `show` (1-based). */
export async function removeRecordingStep(
  name: string,
  stepNumber: number,
  dir = DEFAULT_DIR,
): Promise<{ recording: Recording; removed: RecordedStep[]; file: string }> {
  const rec = await loadRecording(name, dir);
  if (!rec) throw new Error(`Gravação "${name}" não encontrada`);
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > rec.steps.length) {
    throw new Error(`Passo ${stepNumber} fora do intervalo 1..${rec.steps.length}`);
  }

  const index = stepNumber - 1;
  const removed = rec.steps.splice(index, 1);
  // Um clique/tecla/select/check pode ter gerado o waitForUrl logo seguinte.
  // Ao apagar a ação errada, apaga também essa consequência.
  if (["click", "press", "select", "check"].includes(removed[0].type) && rec.steps[index]?.type === "waitForUrl") {
    removed.push(...rec.steps.splice(index, 1));
  }
  rec.updatedAt = new Date().toISOString();
  const file = await saveRecording(rec, dir);
  // Os índices do checkpoint deixam de ser confiáveis depois da edição.
  await clearCheckpoint(name, dir);
  return { recording: rec, removed, file };
}

export async function saveCheckpoint(cp: Checkpoint, dir = DEFAULT_DIR): Promise<string> {
  const file = checkpointPath(cp.recording, dir);
  await writeJsonAtomic(file, cp);
  return file;
}

export const loadCheckpoint = (name: string, dir = DEFAULT_DIR) =>
  readJson<Checkpoint>(checkpointPath(name, dir));

export const clearCheckpoint = (name: string, dir = DEFAULT_DIR) =>
  rm(checkpointPath(name, dir), { force: true });
