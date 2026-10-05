/**
 * Persistência das gravações (`recordings/<nome>.json`) e dos checkpoints de
 * replay (`recordings/<nome>.checkpoint.json`, ignorado pelo Git porque guarda
 * cookies da sessão).
 */

import path from "node:path";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Checkpoint, Recording } from "./types.js";

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

export async function saveCheckpoint(cp: Checkpoint, dir = DEFAULT_DIR): Promise<string> {
  const file = checkpointPath(cp.recording, dir);
  await writeJsonAtomic(file, cp);
  return file;
}

export const loadCheckpoint = (name: string, dir = DEFAULT_DIR) =>
  readJson<Checkpoint>(checkpointPath(name, dir));

export const clearCheckpoint = (name: string, dir = DEFAULT_DIR) =>
  rm(checkpointPath(name, dir), { force: true });
