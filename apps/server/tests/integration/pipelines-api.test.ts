import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiErrorSchema, DEFAULT_PIPELINE_ID, PipelineSchema, SettingsSchema, type Pipeline } from "@orchestrator/shared";
import { startServer, type RunningServer } from "../../src/main.js";
import { FakeAgentRunner } from "../fakes/fake-agent-runner.js";
import { createTempRepo, type TempRepo } from "../fakes/temp-repo.js";

const INVALID_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STEP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let dataDir: string;
let server: RunningServer;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-pipelines-api-"));
  server = await startServer({ port: 0, dataDir, agentRunner: new FakeAgentRunner() });
});

afterEach(async () => {
  await server.executor.whenIdle();
  await server.close();
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

const errorOf = (res: Response) => ApiErrorSchema.parse(res.body).error;
const pipelineOf = (res: Response): Pipeline => PipelineSchema.parse(res.body);

const miniInput = (name = "Mini") => ({
  name,
  steps: [
    { name: "Specify", model: "sonnet", command: "/speckit-specify", interactive: false },
    { name: "Plan", model: "opus", command: "/speckit-plan", interactive: false, timeoutMinutes: 45 },
  ],
});

async function createMini(name = "Mini"): Promise<Pipeline> {
  const res = await call("POST", "/api/pipelines", miniInput(name));
  expect(res.status).toBe(201);
  return pipelineOf(res);
}

describe("GET /api/pipelines", () => {
  it("lista a padrão primeiro e as demais por nome", async () => {
    await createMini("Zeta");
    await createMini("Alfa");
    const res = await call("GET", "/api/pipelines");
    expect(res.status).toBe(200);
    const names = (res.body as Pipeline[]).map((pipeline) => pipeline.name);
    expect(names).toEqual(["Spec Kit (padrão)", "Alfa", "Zeta"]);
    expect((res.body as Pipeline[])[0]!.id).toBe(DEFAULT_PIPELINE_ID);
  });

  it("omite arquivos inválidos gravados direto no data dir", async () => {
    await writeFile(join(dataDir, "pipelines", `${INVALID_ID}.json`), JSON.stringify({ id: INVALID_ID, name: "" }));
    const res = await call("GET", "/api/pipelines");
    expect((res.body as Pipeline[]).map((pipeline) => pipeline.id)).not.toContain(INVALID_ID);
  });
});

describe("GET /api/pipelines/:id", () => {
  it("devolve a esteira", async () => {
    const created = await createMini();
    const res = await call("GET", `/api/pipelines/${created.id}`);
    expect(res.status).toBe(200);
    expect(pipelineOf(res)).toEqual(created);
  });

  it("id inexistente → 404 NOT_FOUND", async () => {
    const res = await call("GET", "/api/pipelines/ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("NOT_FOUND");
  });

  it("arquivo inválido → 422 PIPELINE_INVALID com issues", async () => {
    await writeFile(join(dataDir, "pipelines", `${INVALID_ID}.json`), JSON.stringify({ id: INVALID_ID, name: "" }));
    const res = await call("GET", `/api/pipelines/${INVALID_ID}`);
    expect(res.status).toBe(422);
    const error = errorOf(res);
    expect(error.code).toBe("PIPELINE_INVALID");
    expect(error.issues?.length).toBeGreaterThan(0);
  });
});

describe("POST /api/pipelines", () => {
  it("cria com id, ids de passo gerados, isDefault false e datas", async () => {
    const res = await call("POST", "/api/pipelines", miniInput());
    expect(res.status).toBe(201);
    const pipeline = pipelineOf(res);
    expect(pipeline.name).toBe("Mini");
    expect(pipeline.isDefault).toBe(false);
    expect(pipeline.steps.map((step) => step.name)).toEqual(["Specify", "Plan"]);
    expect(pipeline.steps.every((step) => typeof step.id === "string")).toBe(true);
    expect(pipeline.steps[1]!.timeoutMinutes).toBe(45);
    expect(pipeline.createdAt).toBe(pipeline.updatedAt);
  });

  it("mantém o id de passo informado", async () => {
    const input = miniInput();
    const res = await call("POST", "/api/pipelines", { ...input, steps: [{ ...input.steps[0]!, id: STEP_ID }] });
    expect(pipelineOf(res).steps[0]!.id).toBe(STEP_ID);
  });

  it.each([
    [{ name: "", steps: miniInput().steps }, ["name"], "Informe um nome para a esteira"],
    [{ name: "X", steps: [] }, ["steps"], "A esteira precisa de pelo menos um passo"],
    [
      { name: "X", steps: [{ name: "A", model: "sonnet", interactive: false }] },
      ["steps", 0, "command"],
      "Informe a skill ou comando do passo",
    ],
    [
      { name: "X", steps: [{ name: "A", model: "sonnet", command: "/a", timeoutMinutes: 0 }] },
      ["steps", 0, "timeoutMinutes"],
      "O limite de tempo deve estar entre 1 e 1440 minutos",
    ],
    [
      {
        name: "X",
        steps: [
          { name: "A", model: "sonnet", command: "/a" },
          { name: "A", model: "sonnet", command: "/b" },
        ],
      },
      ["steps", 1, "name"],
      "Já existe um passo com este nome",
    ],
  ])("corpo inválido → 400 VALIDATION_FAILED (%#)", async (body, path, message) => {
    const res = await call("POST", "/api/pipelines", body);
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.issues).toContainEqual({ path, message });
  });

  it("nome repetido (sem diferenciar maiúsculas) → 400 com path [name]", async () => {
    await createMini("Mini");
    const res = await call("POST", "/api/pipelines", miniInput("  mini "));
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.issues?.[0]).toEqual({ path: ["name"], message: "Já existe uma esteira com este nome" });
  });
});

describe("PUT /api/pipelines/:id", () => {
  it("atualiza mantendo id/createdAt, renova updatedAt e preserva a ordem", async () => {
    const created = await createMini();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reordered = { name: "Mini 2", steps: [created.steps[1]!, created.steps[0]!] };
    const res = await call("PUT", `/api/pipelines/${created.id}`, reordered);
    expect(res.status).toBe(200);
    const updated = pipelineOf(res);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    expect(updated.name).toBe("Mini 2");
    expect(updated.steps.map((step) => step.name)).toEqual(["Plan", "Specify"]);
    expect(updated.steps.map((step) => step.id)).toEqual([created.steps[1]!.id, created.steps[0]!.id]);
    expect(pipelineOf(await call("GET", `/api/pipelines/${created.id}`))).toEqual(updated);
  });

  it("pode manter o próprio nome", async () => {
    const created = await createMini();
    const res = await call("PUT", `/api/pipelines/${created.id}`, miniInput("Mini"));
    expect(res.status).toBe(200);
  });

  it("nome de outra esteira → 400 com path [name]", async () => {
    await createMini("Outra");
    const created = await createMini();
    const res = await call("PUT", `/api/pipelines/${created.id}`, miniInput("Outra"));
    expect(res.status).toBe(400);
    expect(errorOf(res).issues?.[0]?.path).toEqual(["name"]);
  });

  it("corpo inválido → 400; id inexistente → 404", async () => {
    const created = await createMini();
    expect((await call("PUT", `/api/pipelines/${created.id}`, { name: "", steps: [] })).status).toBe(400);
    const missing = await call("PUT", "/api/pipelines/ffffffff-ffff-4fff-8fff-ffffffffffff", miniInput("Nova"));
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/pipelines/:id/duplicate", () => {
  it("duplica com nome '<nome> (cópia)' e isDefault false", async () => {
    const res = await call("POST", `/api/pipelines/${DEFAULT_PIPELINE_ID}/duplicate`);
    expect(res.status).toBe(201);
    const copy = pipelineOf(res);
    expect(copy.name).toBe("Spec Kit (padrão) (cópia)");
    expect(copy.isDefault).toBe(false);
    expect(copy.id).not.toBe(DEFAULT_PIPELINE_ID);
    expect(copy.steps.map((step) => step.command)).toEqual([
      "/speckit-specify",
      "/speckit-clarify",
      "/speckit-plan",
      "/speckit-tasks",
      "/speckit-implement",
    ]);
  });

  it("duplicar de novo gera um nome único", async () => {
    const first = pipelineOf(await call("POST", `/api/pipelines/${DEFAULT_PIPELINE_ID}/duplicate`));
    const second = pipelineOf(await call("POST", `/api/pipelines/${DEFAULT_PIPELINE_ID}/duplicate`));
    expect(second.name).not.toBe(first.name);
  });
});

describe("DELETE /api/pipelines/:id", () => {
  it("exclui → 204 e some da lista", async () => {
    const created = await createMini();
    const res = await call("DELETE", `/api/pipelines/${created.id}`);
    expect(res.status).toBe(204);
    expect((await call("GET", `/api/pipelines/${created.id}`)).status).toBe(404);
  });

  it("a padrão → 409 INVALID_STATE", async () => {
    const res = await call("DELETE", `/api/pipelines/${DEFAULT_PIPELINE_ID}`);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("INVALID_STATE");
  });
});

describe("persistência e execução", () => {
  it("a esteira salva continua listada após reiniciar o servidor (FR-025)", async () => {
    const created = await createMini();
    await server.close();
    server = await startServer({ port: 0, dataDir, agentRunner: new FakeAgentRunner() });
    const res = await call("GET", "/api/pipelines");
    expect((res.body as Pipeline[]).map((pipeline) => pipeline.id)).toContain(created.id);
  });

  describe("POST /api/runs", () => {
    let repo: TempRepo;

    beforeEach(async () => {
      repo = await createTempRepo();
      await repo.writeFile(".claude/skills/speckit-specify/SKILL.md", "# specify\n");
      await repo.writeFile(".claude/skills/speckit-plan/SKILL.md", "# plan\n");
      await repo.git("add", "-A");
      await repo.git("commit", "-m", "skills");
    });

    afterEach(async () => {
      await server.executor.whenIdle();
      await repo.cleanup();
    });

    const startBody = (pipelineId: string) => ({
      repoPath: repo.path,
      pipelineId,
      description: "Adicionar login",
      expectedBranch: "main",
    });

    it("esteira inválida no disco é recusada (FR-024)", async () => {
      await writeFile(join(dataDir, "pipelines", `${INVALID_ID}.json`), JSON.stringify({ id: INVALID_ID, name: "" }));
      const res = await call("POST", "/api/runs", startBody(INVALID_ID));
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe("PIPELINE_INVALID");
    });

    it("executa uma esteira personalizada e grava lastPipelineId", async () => {
      const created = await createMini();
      const res = await call("POST", "/api/runs", startBody(created.id));
      expect(res.status).toBe(201);
      expect((res.body as { pipeline: Pipeline }).pipeline.id).toBe(created.id);
      const settings = SettingsSchema.parse((await call("GET", "/api/settings")).body);
      expect(settings.lastPipelineId).toBe(created.id);
    });
  });
});
