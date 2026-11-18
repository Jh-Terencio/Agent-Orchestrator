import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPipeline, type OutputEntry, type PipelineInput, type Run } from "@orchestrator/shared";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { ensureDataDirs, resolveDataDir } from "../../src/storage/data-dir.js";
import { PipelineStore } from "../../src/storage/pipeline-store.js";
import { RunStore } from "../../src/storage/run-store.js";
import { SettingsStore } from "../../src/storage/settings-store.js";
import { ApiError } from "../../src/http/errors.js";

const DEFAULT_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-11-17T12:00:00.000Z";

let dataDir: string;
const originalEnv = process.env.ORCHESTRATOR_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-stores-"));
  process.env.ORCHESTRATOR_DATA_DIR = dataDir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalEnv === undefined) delete process.env.ORCHESTRATOR_DATA_DIR;
  else process.env.ORCHESTRATOR_DATA_DIR = originalEnv;
  await rm(dataDir, { recursive: true, force: true });
});

function pipelineInput(name: string): PipelineInput {
  return {
    name,
    steps: [{ name: "Specify", model: "sonnet", command: "/speckit-specify", interactive: false }],
  };
}

function validRun(id = "11111111-1111-4111-8111-111111111111"): Run {
  const pipeline = createDefaultPipeline(NOW);
  return {
    schemaVersion: 1,
    id,
    pipeline,
    repoPath: "C:/repos/alvo",
    description: "Adicionar login",
    sourceBranch: "main",
    refSnapshot: [{ ref: "refs/heads/main", sha: "a".repeat(40) }],
    initialBranch: "orchestrator/20261117-120000-adicionar-login",
    createdBranches: ["orchestrator/20261117-120000-adicionar-login"],
    finalBranch: null,
    status: "running",
    startedAt: NOW,
    finishedAt: null,
    steps: pipeline.steps.map((step) => ({
      stepId: step.id,
      status: "waiting",
      sessionId: null,
      replies: [],
      invocations: [],
      errorMessage: null,
      interruptReason: null,
      commitSha: null,
      branchAtEnd: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      usage: null,
    })),
  };
}

function entry(seq: number, text = `linha ${seq}`): OutputEntry {
  return { seq, at: NOW, kind: "text", text };
}

describe("data-dir", () => {
  it("resolveDataDir usa ORCHESTRATOR_DATA_DIR quando definido", () => {
    expect(resolveDataDir()).toBe(dataDir);
  });

  it("resolveDataDir usa a pasta padrão da plataforma sem a variável", () => {
    delete process.env.ORCHESTRATOR_DATA_DIR;
    const resolved = resolveDataDir();
    if (process.platform === "win32") {
      expect(resolved).toBe(join(process.env.APPDATA ?? "", "agent-orchestrator"));
    } else {
      expect(resolved).toMatch(/[/\\]\.local[/\\]share[/\\]agent-orchestrator$/);
    }
  });

  it("ensureDataDirs cria pipelines/ e runs/", async () => {
    await ensureDataDirs();
    expect((await readdir(dataDir)).sort()).toEqual(["pipelines", "runs"]);
  });
});

describe("atomicWriteJson", () => {
  it("substitui o conteúdo e não deixa *.tmp", async () => {
    const file = join(dataDir, "x.json");
    await atomicWriteJson(file, { a: 1 });
    await atomicWriteJson(file, { a: 2 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ a: 2 });
    expect((await readdir(dataDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("PipelineStore", () => {
  it("init grava a esteira padrão quando pipelines/ está vazia", async () => {
    const store = new PipelineStore();
    await store.init();
    expect(await readdir(join(dataDir, "pipelines"))).toEqual([`${DEFAULT_ID}.json`]);
    const pipelines = await store.list();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.isDefault).toBe(true);
  });

  it("init não regrava a padrão se já houver arquivos", async () => {
    const store = new PipelineStore();
    const custom = await store.create(pipelineInput("Minha"));
    await store.init();
    expect(await readdir(join(dataDir, "pipelines"))).toEqual([`${custom.id}.json`]);
  });

  it("list retorna a padrão primeiro e depois por nome", async () => {
    const store = new PipelineStore();
    await store.init();
    await store.create(pipelineInput("Zeta"));
    await store.create(pipelineInput("Alfa"));
    const names = (await store.list()).map((pipeline) => pipeline.name);
    expect(names).toEqual(["Spec Kit (padrão)", "Alfa", "Zeta"]);
  });

  it("list ignora arquivo inválido com aviso; get lança 422 PIPELINE_INVALID com issues", async () => {
    const store = new PipelineStore();
    await store.init();
    const badId = "22222222-2222-4222-8222-222222222222";
    const badPath = join(dataDir, "pipelines", `${badId}.json`);
    await writeFile(badPath, JSON.stringify({ schemaVersion: 1, id: badId, name: "", steps: [] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pipelines = await store.list();
    expect(pipelines.map((pipeline) => pipeline.id)).toEqual([DEFAULT_ID]);
    expect(warn).toHaveBeenCalledTimes(1);
    const warned = warn.mock.calls[0]?.map(String).join(" ") ?? "";
    expect(warned).toContain(badPath);
    expect(warned).toContain("Informe um nome para a esteira");

    const error = await store.get(badId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "PIPELINE_INVALID" });
    expect((error as ApiError).issues).toEqual(
      expect.arrayContaining([{ path: ["name"], message: "Informe um nome para a esteira" }]),
    );
  });

  it("get de id inexistente lança 404 NOT_FOUND", async () => {
    const store = new PipelineStore();
    await store.init();
    await expect(store.get("33333333-3333-4333-8333-333333333333")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("create, update, nameExists e delete", async () => {
    const store = new PipelineStore();
    await store.init();
    const created = await store.create(pipelineInput("  Minha  "));
    expect(created).toMatchObject({ name: "Minha", isDefault: false, schemaVersion: 1 });
    expect(created.steps[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.get(created.id)).toEqual(created);

    expect(await store.nameExists("Minha")).toBe(true);
    expect(await store.nameExists("Minha", created.id)).toBe(false);
    expect(await store.nameExists("Outra")).toBe(false);

    const updated = await store.update(created.id, pipelineInput("Renomeada"));
    expect(updated).toMatchObject({ id: created.id, name: "Renomeada", createdAt: created.createdAt });
    expect(await store.get(created.id)).toEqual(updated);

    await store.delete(created.id);
    await expect(store.get(created.id)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("delete da esteira padrão lança 409 INVALID_STATE", async () => {
    const store = new PipelineStore();
    await store.init();
    await expect(store.delete(DEFAULT_ID)).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
  });
});

describe("RunStore", () => {
  it("save/get faz ida e volta do Run", async () => {
    const store = new RunStore();
    const run = validRun();
    await store.save(run);
    expect(await store.get(run.id)).toEqual(run);
    run.status = "completed";
    await store.save(run);
    expect((await store.get(run.id)).status).toBe("completed");
    expect((await readdir(join(dataDir, "runs", run.id))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("get de id inexistente lança 404 NOT_FOUND", async () => {
    const store = new RunStore();
    await expect(store.get("44444444-4444-4444-8444-444444444444")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("listAll lê todos os run.json", async () => {
    const store = new RunStore();
    await store.save(validRun("11111111-1111-4111-8111-111111111111"));
    await store.save(validRun("55555555-5555-4555-8555-555555555555"));
    const ids = (await store.listAll()).map((run) => run.id).sort();
    expect(ids).toEqual(["11111111-1111-4111-8111-111111111111", "55555555-5555-4555-8555-555555555555"]);
  });

  it("listAll ignora run.json inválido com aviso", async () => {
    const store = new RunStore();
    await store.save(validRun());
    const badDir = join(dataDir, "runs", "66666666-6666-4666-8666-666666666666");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "run.json"), "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await store.listAll()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("appendOutput grava uma linha por entrada e readOutput filtra por afterSeq", async () => {
    const store = new RunStore();
    const run = validRun();
    await store.save(run);
    await store.appendOutput(run.id, 0, [entry(1), entry(2)]);
    await store.appendOutput(run.id, 0, [entry(3, "com\nquebra de linha")]);

    const raw = await readFile(join(dataDir, "runs", run.id, "0.output.jsonl"), "utf8");
    expect(raw.split("\n").filter((line) => line.length > 0)).toHaveLength(3);

    expect(await store.readOutput(run.id, 0)).toEqual([entry(1), entry(2), entry(3, "com\nquebra de linha")]);
    expect((await store.readOutput(run.id, 0, 1)).map((item) => item.seq)).toEqual([2, 3]);
    expect(await store.readOutput(run.id, 0, 3)).toEqual([]);
    expect(await store.readOutput(run.id, 1)).toEqual([]);
  });

  it("nextSeq é monotônico por passo e continua do arquivo existente", async () => {
    const store = new RunStore();
    const run = validRun();
    await store.save(run);
    expect(await store.nextSeq(run.id, 0)).toBe(1);
    expect(await store.nextSeq(run.id, 0)).toBe(2);
    expect(await store.nextSeq(run.id, 1)).toBe(1);

    await store.appendOutput(run.id, 2, [entry(1), entry(2), entry(7)]);
    const fresh = new RunStore();
    expect(await fresh.nextSeq(run.id, 2)).toBe(8);
  });
});

describe("SettingsStore", () => {
  it("get retorna o padrão quando não há arquivo", async () => {
    const store = new SettingsStore();
    expect(await store.get()).toEqual({ recentRepos: [], lastPipelineId: null });
  });

  it("addRecentRepo mantém no máximo 10, mais recente primeiro, sem duplicatas", async () => {
    const store = new SettingsStore();
    for (let i = 1; i <= 12; i++) await store.addRecentRepo(`C:/repos/r${i}`);
    await store.addRecentRepo("C:/repos/r5");
    const { recentRepos } = await store.get();
    expect(recentRepos).toEqual([
      "C:/repos/r5",
      "C:/repos/r12",
      "C:/repos/r11",
      "C:/repos/r10",
      "C:/repos/r9",
      "C:/repos/r8",
      "C:/repos/r7",
      "C:/repos/r6",
      "C:/repos/r4",
      "C:/repos/r3",
    ]);
    expect(JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")).recentRepos).toEqual(recentRepos);
  });

  it("setLastPipelineId persiste o id", async () => {
    await new SettingsStore().setLastPipelineId(DEFAULT_ID);
    expect((await new SettingsStore().get()).lastPipelineId).toBe(DEFAULT_ID);
  });
});
