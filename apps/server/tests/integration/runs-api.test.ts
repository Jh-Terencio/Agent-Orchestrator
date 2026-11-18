import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ApiErrorSchema,
  createDefaultPipeline,
  PipelineSchema,
  RunSchema,
  ServerEventSchema,
  type Pipeline,
  type Run,
  type ServerEvent,
} from "@orchestrator/shared";
import { startServer, type RunningServer } from "../../src/main.js";
import { FakeAgentRunner, type FakeScript } from "../fakes/fake-agent-runner.js";
import { createTempRepo, type TempRepo } from "../fakes/temp-repo.js";

const NOW = "2026-11-17T12:00:00.000Z";
const NON_INTERACTIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INTERACTIVE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVALID_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let dataDir: string;
let repo: TempRepo;
let server: RunningServer;
let runner: FakeAgentRunner;
let sockets: WebSocket[];
let counter = 0;

const writesFile: NonNullable<FakeScript["sideEffect"]> = async (cwd) => {
  counter += 1;
  await writeFile(join(cwd, `out-${counter}.md`), `${counter}\n`);
};

function pipelineWith(id: string, name: string, interactive: boolean): Pipeline {
  const base = createDefaultPipeline(NOW);
  return PipelineSchema.parse({
    ...base,
    id,
    name,
    isDefault: false,
    steps: [{ ...base.steps[0]!, interactive }],
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-runs-api-"));
  repo = await createTempRepo();
  for (const name of ["speckit-specify", "speckit-clarify", "speckit-plan", "speckit-tasks", "speckit-implement"]) {
    await repo.writeFile(`.claude/skills/${name}/SKILL.md`, `# ${name}\n`);
  }
  await repo.git("add", "-A");
  await repo.git("commit", "-m", "skills");

  runner = new FakeAgentRunner([], { sideEffect: writesFile });
  server = await startServer({ port: 0, dataDir, agentRunner: runner });
  await writeFile(
    join(dataDir, "pipelines", `${NON_INTERACTIVE_ID}.json`),
    JSON.stringify(pipelineWith(NON_INTERACTIVE_ID, "Só Specify", false)),
  );
  await writeFile(
    join(dataDir, "pipelines", `${INTERACTIVE_ID}.json`),
    JSON.stringify(pipelineWith(INTERACTIVE_ID, "Specify interativo", true)),
  );
  await writeFile(join(dataDir, "pipelines", `${INVALID_ID}.json`), JSON.stringify({ id: INVALID_ID, name: "" }));
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

const startBody = (overrides: Record<string, unknown> = {}) => ({
  repoPath: repo.path,
  pipelineId: NON_INTERACTIVE_ID,
  description: "Adicionar login",
  expectedBranch: "main",
  ...overrides,
});

const errorCode = (res: Response) => ApiErrorSchema.parse(res.body).error;

async function listen(): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(ws);
  ws.on("message", (data: WebSocket.RawData) => events.push(ServerEventSchema.parse(JSON.parse(data.toString()))));
  await new Promise<void>((resolve, reject) => {
    ws.once("message", () => resolve());
    ws.once("error", reject);
  });
  return events;
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("tempo esgotado esperando a condição");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("POST /api/runs", () => {
  it("201 Run e o run evolui até completed, com run.updated e run.finished pelo WS", async () => {
    const events = await listen();
    const res = await call("POST", "/api/runs", startBody());
    expect(res.status).toBe(201);
    const run = RunSchema.parse(res.body);
    expect(run.pipeline.id).toBe(NON_INTERACTIVE_ID);

    const finishedEvent = await waitFor(() => events.find((event) => event.type === "run.finished"));
    expect(finishedEvent).toMatchObject({ run: { id: run.id, status: "completed" } });
    const updates = events.filter((event) => event.type === "run.updated");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(events.indexOf(finishedEvent)).toBe(events.length - 1);

    const fetched = await call("GET", `/api/runs/${run.id}`);
    expect(fetched.status).toBe(200);
    expect(RunSchema.parse(fetched.body).status).toBe("completed");
  });

  it("corpo sem descrição → 400 VALIDATION_FAILED", async () => {
    const res = await call("POST", "/api/runs", startBody({ description: "   " }));
    expect(res.status).toBe(400);
    expect(errorCode(res).code).toBe("VALIDATION_FAILED");
    expect(errorCode(res).issues?.[0]?.path).toEqual(["description"]);
  });

  it("repositório sujo → 422 REPO_REJECTED com details.problems", async () => {
    await repo.writeFile("sujo.txt", "x");
    const res = await call("POST", "/api/runs", startBody());
    expect(res.status).toBe(422);
    expect(errorCode(res)).toMatchObject({ code: "REPO_REJECTED", details: { problems: ["dirty_worktree"] } });
  });

  it("segundo POST com run ativo → 409 RUN_ALREADY_ACTIVE", async () => {
    const first = await call("POST", "/api/runs", startBody({ pipelineId: INTERACTIVE_ID }));
    expect(first.status).toBe(201);
    const second = await call("POST", "/api/runs", startBody({ pipelineId: INTERACTIVE_ID }));
    expect(second.status).toBe(409);
    expect(errorCode(second).code).toBe("RUN_ALREADY_ACTIVE");
  });

  it("expectedBranch diferente → 409 BRANCH_CHANGED com details.currentBranch", async () => {
    const res = await call("POST", "/api/runs", startBody({ expectedBranch: "develop" }));
    expect(res.status).toBe(409);
    expect(errorCode(res)).toMatchObject({ code: "BRANCH_CHANGED", details: { currentBranch: "main" } });
  });

  it("esteira com arquivo inválido → 422 PIPELINE_INVALID", async () => {
    const res = await call("POST", "/api/runs", startBody({ pipelineId: INVALID_ID }));
    expect(res.status).toBe(422);
    expect(errorCode(res).code).toBe("PIPELINE_INVALID");
    expect(errorCode(res).issues?.length).toBeGreaterThan(0);
  });

  it("esteira inexistente → 404 NOT_FOUND", async () => {
    const res = await call("POST", "/api/runs", startBody({ pipelineId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));
    expect(res.status).toBe(404);
    expect(errorCode(res).code).toBe("NOT_FOUND");
  });
});

describe("GET /api/runs/active e /api/runs/:id", () => {
  it("204 sem run ativo e 200 Run com run ativo", async () => {
    expect((await call("GET", "/api/runs/active")).status).toBe(204);
    const started = RunSchema.parse((await call("POST", "/api/runs", startBody({ pipelineId: INTERACTIVE_ID }))).body);
    const active = await call("GET", "/api/runs/active");
    expect(active.status).toBe(200);
    expect(RunSchema.parse(active.body).id).toBe(started.id);
  });

  it("GET /api/runs/:id inexistente → 404 NOT_FOUND", async () => {
    const res = await call("GET", "/api/runs/dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(res.status).toBe(404);
    expect(errorCode(res).code).toBe("NOT_FOUND");
  });

  it("GET /api/pipelines lista a esteira padrão primeiro e ignora o arquivo inválido", async () => {
    const res = await call("GET", "/api/pipelines");
    expect(res.status).toBe(200);
    const list = PipelineSchema.array().parse(res.body);
    expect(list[0]?.isDefault).toBe(true);
    expect(list.map((pipeline) => pipeline.id)).not.toContain(INVALID_ID);
    expect(list).toHaveLength(3);
  });
});

describe("POST /api/runs/:id/reply e /advance", () => {
  async function startInteractive(): Promise<{ run: Run; events: ServerEvent[] }> {
    const events = await listen();
    const run = RunSchema.parse((await call("POST", "/api/runs", startBody({ pipelineId: INTERACTIVE_ID }))).body);
    await waitFor(() =>
      events.find((event) => event.type === "run.updated" && event.run.status === "awaiting_input"),
    );
    return { run, events };
  }

  it("fora de awaiting_input → 409 INVALID_STATE", async () => {
    runner.enqueue({ sideEffect: writesFile, delayMs: 500 });
    const run = RunSchema.parse((await call("POST", "/api/runs", startBody({ pipelineId: INTERACTIVE_ID }))).body);
    const replyRes = await call("POST", `/api/runs/${run.id}/reply`, { text: "oi" });
    expect(replyRes.status).toBe(409);
    expect(errorCode(replyRes).code).toBe("INVALID_STATE");
    const advanceRes = await call("POST", `/api/runs/${run.id}/advance`);
    expect(advanceRes.status).toBe(409);
    expect(errorCode(advanceRes).code).toBe("INVALID_STATE");
  });

  it("reply → 202 e o passo volta a awaiting_input; advance → 202 e o run termina", async () => {
    const { run, events } = await startInteractive();
    const replyRes = await call("POST", `/api/runs/${run.id}/reply`, { text: "Use OAuth" });
    expect(replyRes.status).toBe(202);
    await waitFor(() =>
      events.find(
        (event) =>
          event.type === "run.updated" &&
          event.run.status === "awaiting_input" &&
          event.run.steps[0]?.replies.length === 1,
      ),
    );
    expect(runner.invocations.at(-1)).toMatchObject({ prompt: "Use OAuth", resume: true });

    const advanceRes = await call("POST", `/api/runs/${run.id}/advance`);
    expect(advanceRes.status).toBe(202);
    const finished = await waitFor(() => events.find((event) => event.type === "run.finished"));
    expect(finished).toMatchObject({ run: { status: "completed" } });
  });

  it("reply com text vazio → 400", async () => {
    const { run } = await startInteractive();
    const res = await call("POST", `/api/runs/${run.id}/reply`, { text: "  " });
    expect(res.status).toBe(400);
    expect(errorCode(res).code).toBe("VALIDATION_FAILED");
  });

  it("hello do WebSocket traz o run ativo", async () => {
    const { run } = await startInteractive();
    const events = await listen();
    expect(events[0]).toMatchObject({ type: "hello", activeRun: { id: run.id } });
  });
});

describe("US6: Modo Yolo e pedidos de permissão", () => {
  const NPM_TEST = { toolName: "Bash", input: { command: "npm test" } };

  /** Inicia um run cujo agente pede permissão (pela rota interna, como o relay) e espera o pedido. */
  async function startWithRequest(): Promise<{ run: Run; events: ServerEvent[]; requestId: string }> {
    runner.enqueue({ permissionRequests: [NPM_TEST], delayMs: 300 });
    const events = await listen();
    const run = RunSchema.parse((await call("POST", "/api/runs", startBody())).body);
    const updated = await waitFor(() =>
      events.find((event) => event.type === "run.updated" && event.run.status === "awaiting_permission"),
    );
    const requestId = (updated as { run: Run }).run.steps[0]!.permissionRequests[0]!.id;
    return { run, events, requestId };
  }

  it("POST /api/runs com yolo: true grava run.yolo; sem o campo, false", async () => {
    const yoloRes = await call("POST", "/api/runs", startBody({ yolo: true }));
    expect(yoloRes.status).toBe(201);
    expect(RunSchema.parse(yoloRes.body).yolo).toBe(true);
    await server.executor.whenIdle();
    expect(runner.invocations.at(-1)?.permissionChannel).toBeNull();

    // A execução anterior deixou o repositório na branch dela.
    const branch = await repo.git("branch", "--show-current");
    const defaultRes = await call("POST", "/api/runs", startBody({ expectedBranch: branch }));
    expect(defaultRes.status).toBe(201);
    expect(RunSchema.parse(defaultRes.body).yolo).toBe(false);
    await server.executor.whenIdle();
    expect(runner.invocations.at(-1)?.permissionChannel).not.toBeNull();
  });

  it("decisão → 202 e o run volta a running; repetir → 409 INVALID_STATE e a CLI recebe uma só resposta", async () => {
    const { run, events, requestId } = await startWithRequest();
    const path = `/api/runs/${run.id}/permissions/${requestId}`;
    const before = events.length;
    const first = await call("POST", path, { decision: "allow_once" });
    expect(first.status).toBe(202);
    await waitFor(() =>
      events.slice(before).find((event) => event.type === "run.updated" && event.run.status === "running"),
    );

    const second = await call("POST", path, { decision: "allow_once" });
    expect(second.status).toBe(409);
    expect(errorCode(second).code).toBe("INVALID_STATE");

    await waitFor(() => events.find((event) => event.type === "run.finished"));
    expect(runner.permissionDecisions).toEqual([{ behavior: "allow", updatedInput: NPM_TEST.input }]);
  });

  it("decisão inválida → 400; pedido inexistente → 404", async () => {
    const { run, requestId } = await startWithRequest();
    const bad = await call("POST", `/api/runs/${run.id}/permissions/${requestId}`, { decision: "talvez" });
    expect(bad.status).toBe(400);
    expect(errorCode(bad).code).toBe("VALIDATION_FAILED");
    const missing = await call("POST", `/api/runs/${run.id}/permissions/99999999-9999-4999-8999-999999999999`, {
      decision: "deny",
    });
    expect(missing.status).toBe(404);
    expect(errorCode(missing).code).toBe("NOT_FOUND");
    await call("POST", `/api/runs/${run.id}/permissions/${requestId}`, { decision: "deny" });
  });

  it("POST /api/runs/:id/interrupt é aceito em awaiting_permission", async () => {
    const { run, events } = await startWithRequest();
    const res = await call("POST", `/api/runs/${run.id}/interrupt`);
    expect(res.status).toBe(202);
    const finished = await waitFor(() => events.find((event) => event.type === "run.finished"));
    expect(finished).toMatchObject({ run: { status: "interrupted" } });
    const done = RunSchema.parse((finished as { run: Run }).run);
    expect(done.steps[0]?.permissionRequests[0]?.status).toBe("cancelled");
    expect(runner.permissionDecisions).toEqual([{ behavior: "deny", message: "Execução interrompida." }]);
  });
});
