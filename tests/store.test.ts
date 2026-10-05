import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { newRecording } from "../src/recorder/builder.js";
import { loadRecording, removeRecordingStep, saveRecording } from "../src/recorder/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("removeRecordingStep", () => {
  it("remove pelo número 1-based mostrado no comando show", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "account-store-"));
    dirs.push(dir);
    const rec = newRecording("fluxo", "https://site.example/");
    rec.steps = [
      { type: "goto", url: "https://site.example/" },
      { type: "click", selector: "#errado" },
      { type: "click", selector: "#certo" },
    ];
    await saveRecording(rec, dir);

    const result = await removeRecordingStep("fluxo", 2, dir);

    expect(result.removed).toEqual([{ type: "click", selector: "#errado" }]);
    expect((await loadRecording("fluxo", dir))!.steps).toEqual([
      { type: "goto", url: "https://site.example/" },
      { type: "click", selector: "#certo" },
    ]);
  });

  it("remove também o waitForUrl causado por um clique removido", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "account-store-"));
    dirs.push(dir);
    const rec = newRecording("fluxo", "https://site.example/");
    rec.steps = [
      { type: "goto", url: "https://site.example/" },
      { type: "click", selector: "#errado" },
      { type: "waitForUrl", url: "https://site.example/errado" },
      { type: "click", selector: "#certo" },
    ];
    await saveRecording(rec, dir);

    const result = await removeRecordingStep("fluxo", 2, dir);

    expect(result.removed.map((step) => step.type)).toEqual(["click", "waitForUrl"]);
    expect(result.recording.steps).toEqual([
      { type: "goto", url: "https://site.example/" },
      { type: "click", selector: "#certo" },
    ]);
  });

  it("rejeita número fora do intervalo", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "account-store-"));
    dirs.push(dir);
    const rec = newRecording("fluxo", "https://site.example/");
    rec.steps = [{ type: "goto", url: "https://site.example/" }];
    await saveRecording(rec, dir);

    await expect(removeRecordingStep("fluxo", 0, dir)).rejects.toThrow(/intervalo 1\.\.1/);
    await expect(removeRecordingStep("fluxo", 2, dir)).rejects.toThrow(/intervalo 1\.\.1/);
  });
});
