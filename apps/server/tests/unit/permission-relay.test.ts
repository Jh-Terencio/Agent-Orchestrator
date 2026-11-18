import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { relayCommand } from "../../src/agent/relay-path.js";

const TOKEN = "a".repeat(64);
const FAIL_MESSAGE = "O orquestrador não respondeu ao pedido de permissão; comando negado.";
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

interface Received {
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** Servidor HTTP local que faz o papel do orquestrador. */
async function stub(respond: (received: Received) => Promise<{ status: number; body: unknown }>) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const entry = { headers: req.headers, body: JSON.parse(raw) as unknown };
      received.push(entry);
      void respond(entry).then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/internal/permission-requests`, received };
}

type Message = Record<string, unknown>;

/** Inicia o relay e devolve uma função que envia uma mensagem JSON-RPC e espera a resposta de mesmo id. */
function startRelay(url: string): (message: Message) => Promise<Message> {
  const { command, args } = relayCommand();
  const child = spawn(command, args, {
    env: { ...process.env, ORCHESTRATOR_PERMISSION_URL: url, ORCHESTRATOR_PERMISSION_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const waiting = new Map<unknown, (message: Message) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    waiting.get(message.id)?.(message);
  });
  return (message) =>
    new Promise((resolve) => {
      waiting.set(message.id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    });
}

const CALL = {
  method: "tools/call",
  params: {
    name: "approve",
    arguments: { tool_name: "Bash", input: { command: "npm test", description: "roda" }, tool_use_id: "toolu_1" },
  },
};

function decisionOf(response: Message): unknown {
  const result = response.result as { content: Array<{ type: string; text: string }> };
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

describe("permission relay", () => {
  it("roda o relay.mjs com o node atual", () => {
    expect(relayCommand().command).toBe(process.execPath);
    expect(existsSync(relayCommand().args[0]!)).toBe(true);
  });

  it("initialize ecoa protocolVersion; tools/list expõe só approve; outro método com id → {}", async () => {
    const { url } = await stub(async () => ({ status: 200, body: {} }));
    const send = startRelay(url);
    const init = await send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} } });
    const list = await send({ id: 2, method: "tools/list" });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["approve"]);
    expect((await send({ id: "probe", method: "server/discover" })).result).toEqual({});
  });

  it("tools/call repassa token e corpo e devolve a decisão do orquestrador", async () => {
    const decision = { behavior: "allow", updatedInput: { command: "npm test", description: "roda" } };
    const { url, received } = await stub(async () => ({ status: 200, body: decision }));
    const send = startRelay(url);
    expect(decisionOf(await send({ id: 3, ...CALL }))).toEqual(decision);
    expect(received).toHaveLength(1);
    expect(received[0]!.headers["x-orchestrator-token"]).toBe(TOKEN);
    expect(received[0]!.body).toEqual({
      toolName: "Bash",
      input: { command: "npm test", description: "roda" },
      toolUseId: "toolu_1",
    });
  });

  it("espera uma resposta demorada (2 s)", async () => {
    const decision = { behavior: "deny", message: "Negado pelo usuário no orquestrador." };
    const { url } = await stub(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: decision }), 2000)),
    );
    const send = startRelay(url);
    expect(decisionOf(await send({ id: 4, ...CALL }))).toEqual(decision);
  });

  it("status ≠ 200 → deny (falha fechada)", async () => {
    const { url } = await stub(async () => ({ status: 500, body: { behavior: "allow", updatedInput: {} } }));
    const send = startRelay(url);
    expect(decisionOf(await send({ id: 5, ...CALL }))).toEqual({ behavior: "deny", message: FAIL_MESSAGE });
  });

  it("orquestrador fora do ar → deny (falha fechada)", async () => {
    // Porta efêmera de um servidor já fechado: conexão recusada.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const send = startRelay(`http://127.0.0.1:${port}/internal/permission-requests`);
    expect(decisionOf(await send({ id: 6, ...CALL }))).toEqual({ behavior: "deny", message: FAIL_MESSAGE });
  });

  it("resposta 200 que não é uma decisão válida → deny", async () => {
    const { url } = await stub(async () => ({ status: 200, body: { behavior: "talvez" } }));
    const send = startRelay(url);
    expect(decisionOf(await send({ id: 7, ...CALL }))).toEqual({ behavior: "deny", message: FAIL_MESSAGE });
  });
});
