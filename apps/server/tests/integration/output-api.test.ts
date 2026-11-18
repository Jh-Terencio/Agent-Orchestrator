import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ApiErrorSchema,
  createDefaultPipeline,
  OutputEntrySchema,
  PipelineSchema,
  RunSchema,
  ServerEventSchema,
  type OutputEntry,
  type Pipeline,
  type Run,
  type ServerEvent,
} from "@orchestrator/shared";
import { startServer, type RunningServer } from "../../src/main.js";
import { FakeAgentRunner } from "../fakes/fake-agent-runner.js";
import { createTempRepo, type TempRepo } from "../fakes/temp-repo.js";

const NOW = "2026-11-17T12:00:00.000Z";
const PIPELINE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** SC-003 / SC-004. */
const MAX_LATENCY_MS = 2_000;

let dataDir: string;
let repo: TempRepo;
let server: RunningServer;
let runner: FakeAgentRunner;
let sockets: WebSocket[];

function twoStepPipeline(): Pipeline {
  const base = createDefaultPipeline(NOW);
  return PipelineSchema.parse({
    ...base,
    id: PIPELINE_ID,
    name: "Duas etapas",
    isDefault: false,
    steps: [
      { ...base.steps[0]!, interactive: false },
      { ...base.steps[2]!, interactive: false },
    ],
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-output-api-"));
  repo = await createTempRepo();
  for (const name of ["speckit-specify", "speckit-plan"]) {
    await repo.writeFile(`.claude/skills/${name}/SKILL.md`, `# ${name}\n`);
  }
  await repo.git("add", "-A");
  await repo.git("commit", "-m", "skills");
  runner = new FakeAgentRunner();
  server = await startServer({ port: 0, dataDir, agentRunner: runner });
  await writeFile(join(dataDir, "pipelines", `${PIPELINE_ID}.json`), JSON.stringify(twoStepPipeline()));
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await server.executor.whenIdle();
  await server.close();
  await repo.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

interface Response {
  status: number;
  body: unknown;
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method,
        headers: payload === undefined ? {} : { "Content-Type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface Received {
  event: ServerEvent;
  at: number;
}

async function listen(): Promise<Received[]> {
  const received: Received[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(ws);
  ws.on("message", (data: WebSocket.RawData) =>
    received.push({ event: ServerEventSchema.parse(JSON.parse(data.toString())), at: Date.now() }),
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("message", () => resolve());
    ws.once("error", reject);
  });
  return received;
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("tempo esgotado esperando a condição");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startRun(): Promise<Run> {
  const res = await call("POST", "/api/runs", {
    repoPath: repo.path,
    pipelineId: PIPELINE_ID,
    description: "Adicionar login",
    expectedBranch: "main",
  });
  expect(res.status).toBe(201);
  return RunSchema.parse(res.body);
}

const outputOf = (res: Response): OutputEntry[] => OutputEntrySchema.array().parse(res.body);

describe("GET /api/runs/:id/steps/:index/output", () => {
  it("devolve a saída completa e, com ?afterSeq=n, só seq > n", async () => {
    runner.enqueue({
      outputs: [
        { kind: "text", text: "um" },
        { kind: "tool_use", text: "Read: spec.md" },
        { kind: "text", text: "dois" },
      ],
    });
    const run = await startRun();
    await server.executor.whenIdle();

    const full = outputOf(await call("GET", `/api/runs/${run.id}/steps/0/output`));
    expect(full.map((entry) => entry.text)).toEqual([
      "Entrada: /speckit-specify Adicionar login",
      "um",
      "Read: spec.md",
      "dois",
    ]);
    expect(full.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);

    const tail = outputOf(await call("GET", `/api/runs/${run.id}/steps/0/output?afterSeq=2`));
    expect(tail.map((entry) => entry.seq)).toEqual([3, 4]);

    const second = outputOf(await call("GET", `/api/runs/${run.id}/steps/1/output`));
    expect(second[0]?.text).toBe("Entrada: /speckit-plan");
  });

  it("índice fora do intervalo → 404 NOT_FOUND", async () => {
    const run = await startRun();
    await server.executor.whenIdle();
    for (const index of ["2", "-1", "abc"]) {
      const res = await call("GET", `/api/runs/${run.id}/steps/${index}/output`);
      expect(res.status).toBe(404);
      expect(ApiErrorSchema.parse(res.body).error.code).toBe("NOT_FOUND");
    }
  });

  it("run inexistente → 404 NOT_FOUND", async () => {
    const res = await call("GET", "/api/runs/99999999-9999-4999-8999-999999999999/steps/0/output");
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe("NOT_FOUND");
  });

  it("afterSeq inválido → 400 VALIDATION_FAILED", async () => {
    const run = await startRun();
    await server.executor.whenIdle();
    const res = await call("GET", `/api/runs/${run.id}/steps/0/output?afterSeq=xyz`);
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe("VALIDATION_FAILED");
  });
});

describe("streaming pelo WebSocket (SC-003/SC-004)", () => {
  it("step.output chega antes do fim do passo e cada entrada em ≤ 2 s da emissão", async () => {
    const texts = ["parte 1", "parte 2", "parte 3", "parte 4", "parte 5"];
    runner.enqueue({
      outputs: texts.map((text) => ({ kind: "text" as const, text })),
      outputIntervalMs: 150,
      delayMs: 300,
    });
    const received = await listen();
    const run = await startRun();

    await waitFor(() =>
      received.find((item) => item.event.type === "run.finished" && item.event.run.id === run.id),
    );

    const outputs = received.flatMap((item) =>
      item.event.type === "step.output" && item.event.stepIndex === 0
        ? item.event.entries.map((entry) => ({ text: entry.text, at: item.at }))
        : [],
    );
    expect(outputs.map((item) => item.text)).toEqual(["Entrada: /speckit-specify Adicionar login", ...texts]);

    // A saída chegou incrementalmente: a primeira parte antes de o passo 0 sair de `running`.
    const firstPart = received.findIndex(
      (item) => item.event.type === "step.output" && item.event.entries.some((entry) => entry.text === "parte 1"),
    );
    const stepDone = received.findIndex(
      (item) =>
        (item.event.type === "run.updated" || item.event.type === "run.finished") &&
        item.event.run.steps[0]!.status === "completed",
    );
    expect(firstPart).toBeGreaterThanOrEqual(0);
    expect(firstPart).toBeLessThan(stepDone);
    expect(received.filter((item) => item.event.type === "step.output").length).toBeGreaterThan(1);

    for (const emitted of runner.emitted.filter((item) => texts.includes(item.text))) {
      const arrival = outputs.find((item) => item.text === emitted.text)!;
      expect(arrival.at - emitted.at).toBeLessThanOrEqual(MAX_LATENCY_MS);
    }
  });

  it("cada run.updated de mudança de status chega em ≤ 2 s da transição", async () => {
    runner.enqueue({ delayMs: 200 }, { delayMs: 200 });
    const received = await listen();
    const run = await startRun();
    const finished = await waitFor(() =>
      received.find((item) => item.event.type === "run.finished" && item.event.run.id === run.id),
    );
    if (finished.event.type !== "run.finished") throw new Error("inesperado");

    // Para cada passo, o instante da transição para running (startedAt) e para o estado final (finishedAt)
    // é comparado com a chegada do primeiro evento que traz esse status.
    finished.event.run.steps.forEach((step, index) => {
      const checks: Array<{ status: string; at: string | null }> = [
        { status: "running", at: step.startedAt },
        { status: "completed", at: step.finishedAt },
      ];
      for (const check of checks) {
        expect(check.at).not.toBeNull();
        const arrival = received.find(
          (item) =>
            (item.event.type === "run.updated" || item.event.type === "run.finished") &&
            item.event.run.steps[index]!.status === check.status,
        );
        expect(arrival, `passo ${index} → ${check.status}`).toBeDefined();
        expect(arrival!.at - Date.parse(check.at!)).toBeLessThanOrEqual(MAX_LATENCY_MS);
      }
    });
  });
});
