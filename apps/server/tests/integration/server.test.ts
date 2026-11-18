import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ApiErrorSchema, RepoInfoSchema, ServerEventSchema, SettingsSchema } from "@orchestrator/shared";
import { startServer, type RunningServer } from "../../src/main.js";
import { FakeAgentRunner } from "../fakes/fake-agent-runner.js";
import { createTempRepo, type TempRepo } from "../fakes/temp-repo.js";

let dataDir: string;
let server: RunningServer;
let repo: TempRepo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-server-"));
  repo = await createTempRepo();
  server = await startServer({ port: 0, dataDir, agentRunner: new FakeAgentRunner() });
});

afterAll(async () => {
  await server.close();
  await repo.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

interface Response {
  status: number;
  body: unknown;
}

/** `node:http` em vez de `fetch` para poder definir `Host` e `Origin` livremente. */
function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.port, path, method: "GET", headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function openWs(origin?: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${server.port}/ws`, origin === undefined ? {} : { origin });
}

describe("servidor", () => {
  it("escuta só em 127.0.0.1", () => {
    expect((server.server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("Origin estranho → 403 FORBIDDEN_ORIGIN", async () => {
    const res = await get("/api/settings", { Origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("Origin local é aceito", async () => {
    const res = await get("/api/settings", { Origin: `http://localhost:${server.port}` });
    expect(res.status).toBe(200);
  });

  it("Host não local → 403", async () => {
    const res = await get("/api/settings", { Host: `evil.example:${server.port}` });
    expect(res.status).toBe(403);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("rota inexistente sob /api → 404 NOT_FOUND no formato de erro", async () => {
    const res = await get("/api/nao-existe");
    expect(res.status).toBe(404);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe("NOT_FOUND");
  });

  it("upgrade WS com Origin estranho é recusado", async () => {
    const ws = openWs("http://evil.example");
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("unexpected-response", (_req, res) => resolve(`status ${res.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    ws.terminate();
    expect(outcome).not.toBe("open");
  });

  it("conexão WS local recebe hello com activeRun null", async () => {
    const ws = openWs(`http://127.0.0.1:${server.port}`);
    const message = await new Promise<unknown>((resolve, reject) => {
      ws.once("message", (data: WebSocket.RawData) => resolve(JSON.parse(data.toString())));
      ws.once("error", reject);
    });
    ws.close();
    expect(ServerEventSchema.parse(message)).toEqual({ type: "hello", activeRun: null });
  });

  it("GET /api/settings → 200 Settings", async () => {
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    expect(SettingsSchema.parse(res.body)).toEqual({ recentRepos: [], lastPipelineId: null });
  });

  it("GET /api/repos/inspect com repo temporário → 200 RepoInfo válido", async () => {
    const res = await get(`/api/repos/inspect?path=${encodeURIComponent(repo.path)}`);
    expect(res.status).toBe(200);
    const info = RepoInfoSchema.parse(res.body);
    expect(info).toMatchObject({ valid: true, currentBranch: "main", problems: [] });
  });

  it("GET /api/repos/inspect com pasta inexistente → 200 com path_not_found", async () => {
    const res = await get(`/api/repos/inspect?path=${encodeURIComponent(join(repo.path, "nada"))}`);
    expect(res.status).toBe(200);
    expect(RepoInfoSchema.parse(res.body).problems).toEqual(["path_not_found"]);
  });

  it("GET /api/repos/inspect sem path → 400 VALIDATION_FAILED", async () => {
    const res = await get("/api/repos/inspect");
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe("VALIDATION_FAILED");
  });

  it("a esteira padrão é gravada na inicialização", async () => {
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dataDir, "pipelines"))).toEqual(["00000000-0000-4000-8000-000000000001.json"]);
  });
});
