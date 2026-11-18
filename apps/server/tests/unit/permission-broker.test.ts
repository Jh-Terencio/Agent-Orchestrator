import { describe, expect, it, vi } from "vitest";
import type { RelayDecision } from "../../src/agent/agent-runner.js";
import { PermissionBroker } from "../../src/execution/permission-broker.js";

const REQ = { toolName: "Bash", input: { command: "npm test" }, toolUseId: "toolu_1" };
const ALLOW: RelayDecision = { behavior: "allow", updatedInput: { command: "npm test" } };

describe("PermissionBroker", () => {
  it("openChannel devolve a URL interna e um token aleatório de 64 hex", () => {
    const broker = new PermissionBroker(() => "http://127.0.0.1:4317");
    const a = broker.openChannel(async () => ALLOW);
    const b = broker.openChannel(async () => ALLOW);
    expect(a.url).toBe("http://127.0.0.1:4317/internal/permission-requests");
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).not.toBe(a.token);
    expect(broker.hasChannel(a.token)).toBe(true);
  });

  it("repassa o pedido ao handler do canal e devolve a decisão", async () => {
    const broker = new PermissionBroker(() => "http://127.0.0.1:1");
    const handler = vi.fn(async () => ALLOW);
    const { token } = broker.openChannel(handler);
    await expect(broker.request(token, REQ)).resolves.toEqual(ALLOW);
    expect(handler).toHaveBeenCalledWith(REQ);
  });

  it("token desconhecido → deny sem chamar nenhum handler", async () => {
    const broker = new PermissionBroker(() => "http://127.0.0.1:1");
    const handler = vi.fn(async () => ALLOW);
    broker.openChannel(handler);
    const decision = await broker.request("f".repeat(64), REQ);
    expect(decision.behavior).toBe("deny");
    expect(handler).not.toHaveBeenCalled();
  });

  it("depois de closeChannel, o pedido seguinte é negado", async () => {
    const broker = new PermissionBroker(() => "http://127.0.0.1:1");
    const handler = vi.fn(async () => ALLOW);
    const { token } = broker.openChannel(handler);
    broker.closeChannel(token);
    expect(broker.hasChannel(token)).toBe(false);
    expect((await broker.request(token, REQ)).behavior).toBe("deny");
    expect(handler).not.toHaveBeenCalled();
  });

  it("pedido pendente quando o canal fecha resolve deny", async () => {
    const broker = new PermissionBroker(() => "http://127.0.0.1:1");
    const { token } = broker.openChannel(() => new Promise<RelayDecision>(() => undefined));
    const pending = broker.request(token, REQ);
    broker.closeChannel(token);
    await expect(pending).resolves.toEqual({
      behavior: "deny",
      message: "A invocação do agente terminou antes da decisão.",
    });
  });

  it("handler que lança → deny (falha fechada)", async () => {
    const broker = new PermissionBroker(() => "http://127.0.0.1:1");
    const { token } = broker.openChannel(async () => {
      throw new Error("disco cheio");
    });
    const decision = await broker.request(token, REQ);
    expect(decision.behavior).toBe("deny");
  });
});
