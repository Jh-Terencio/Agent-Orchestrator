import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectEvents } from "../src/api/ws";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  /** Simula o fim do handshake. */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectEvents: encerramento", () => {
  it("encerrar durante o handshake não aborta o socket: fecha assim que abrir, sem notificar nem reconectar", () => {
    const onStatus = vi.fn();
    const stop = connectEvents(() => {}, onStatus);
    const socket = FakeSocket.instances[0]!;
    stop();
    expect(socket.close).not.toHaveBeenCalled();
    socket.accept();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalledWith("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("encerrar com o socket aberto fecha na hora", () => {
    const stop = connectEvents(() => {}, () => {});
    const socket = FakeSocket.instances[0]!;
    socket.accept();
    stop();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
