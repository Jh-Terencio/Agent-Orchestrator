import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { ServerEventSchema, type Run, type ServerEvent } from "@orchestrator/shared";

export const WS_PATH = "/ws";

export interface EventHubOptions {
  /** Mesma validação de `Origin`/`Host` da API REST. */
  isAllowed: (req: IncomingMessage) => boolean;
  /** Estado inicial enviado no `hello`. */
  getActiveRun: () => Run | null;
}

/** Broadcast de `ServerEvent` para todos os clientes conectados (contracts/websocket-events.md). */
export class EventHub {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    server: Server,
    private readonly options: EventHubOptions,
  ) {
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on("connection", (ws) => this.send(ws, { type: "hello", activeRun: this.options.getActiveRun() }));
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(ServerEventSchema.parse(event));
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  /** Fecha as conexões abertas (usado no shutdown). */
  close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    ws.send(JSON.stringify(ServerEventSchema.parse(event)));
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? "").split("?")[0];
    if (path !== WS_PATH) {
      reject(socket, 404, "Not Found");
      return;
    }
    if (!this.options.isAllowed(req)) {
      reject(socket, 403, "Forbidden");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
