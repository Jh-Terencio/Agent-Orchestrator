import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RelayDecision } from "../../src/agent/agent-runner.js";
import { startServer, type RunningServer } from "../../src/main.js";
import { FakeAgentRunner } from "../fakes/fake-agent-runner.js";

let dataDir: string;
let server: RunningServer;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-internal-"));
  server = await startServer({ port: 0, dataDir, agentRunner: new FakeAgentRunner() });
});

afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});

interface Response {
  status: number;
  body: unknown;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const PATH = "/internal/permission-requests";
const BODY = { toolName: "Bash", input: { command: "npm test" }, toolUseId: "toolu_1" };

describe("POST /internal/permission-requests", () => {
  it("com token válido, segura a resposta até o handler decidir", async () => {
    let decide!: (decision: RelayDecision) => void;
    const received: unknown[] = [];
    const channel = server.permissionBroker.openChannel((req) => {
      received.push(req);
      return new Promise((resolve) => (decide = resolve));
    });
    expect(channel.url).toBe(`http://127.0.0.1:${server.port}${PATH}`);

    let settled = false;
    const pending = post(PATH, BODY, { "x-orchestrator-token": channel.token }).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(received).toEqual([BODY]);

    decide({ behavior: "allow", updatedInput: BODY.input });
    expect(await pending).toEqual({ status: 200, body: { behavior: "allow", updatedInput: BODY.input } });
    server.permissionBroker.closeChannel(channel.token);
  });

  it("sem cabeçalho de token → 403 com deny", async () => {
    const response = await post(PATH, BODY);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ behavior: "deny" });
  });

  it("token desconhecido → 403 com deny", async () => {
    const response = await post(PATH, BODY, { "x-orchestrator-token": "0".repeat(64) });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ behavior: "deny" });
  });

  it("corpo inválido → 400 com deny", async () => {
    const channel = server.permissionBroker.openChannel(async () => ({ behavior: "allow", updatedInput: {} }));
    const response = await post(PATH, { toolName: 3 }, { "x-orchestrator-token": channel.token });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ behavior: "deny" });
    server.permissionBroker.closeChannel(channel.token);
  });

  it("Origin estranho → 403 FORBIDDEN_ORIGIN (origin guard)", async () => {
    const channel = server.permissionBroker.openChannel(async () => ({ behavior: "allow", updatedInput: {} }));
    const response = await post(PATH, BODY, { "x-orchestrator-token": channel.token, origin: "http://evil.example" });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "FORBIDDEN_ORIGIN" } });
    server.permissionBroker.closeChannel(channel.token);
  });
});
