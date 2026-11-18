import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { ServerEventSchema, type OutputEntry, type Run, type ServerEvent } from "@orchestrator/shared";

export const WS_PATH = "/ws";
/** Intervalo máximo entre lotes de `step.output` (contracts/websocket-events.md; SC-003). */
export const OUTPUT_BATCH_MS = 250;

export interface EventHubOptions {
  /** Mesma validação de `Origin`/`Host` da API REST. */
  isAllowed: (req: IncomingMessage) => boolean;
  /** Estado inicial enviado no `hello`. */
  getActiveRun: () => Run | null;
}

/**
 * Broadcast de `ServerEvent` para todos os clientes conectados (contracts/websocket-events.md).
 * A saída dos passos é agrupada em lotes de até `OUTPUT_BATCH_MS` por `runId:stepIndex`; todo evento
 * `run.*` esvazia antes os lotes pendentes, para o cliente nunca ver o status à frente da saída.
 */
export class EventHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  /** Lotes pendentes, em ordem de chegada do primeiro item de cada passo. */
  private readonly pending = new Map<string, { runId: string; stepIndex: number; entries: OutputEntry[] }>();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    server: Server,
    private readonly options: EventHubOptions,
  ) {
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on("connection", (ws) => {
      // Saída pendente sai antes do `hello`, que carrega o snapshot atual.
      this.flush();
      this.sendTo(ws, { type: "hello", activeRun: this.options.getActiveRun() });
    });
  }

  broadcast(event: ServerEvent): void {
    if (event.type !== "step.output") this.flush();
    this.send(event);
  }

  /** Acumula uma entrada de saída; o lote do passo sai em até `OUTPUT_BATCH_MS`. */
  pushOutput(runId: string, stepIndex: number, entry: OutputEntry): void {
    const key = `${runId}:${stepIndex}`;
    const batch = this.pending.get(key);
    if (batch) batch.entries.push(entry);
    else this.pending.set(key, { runId, stepIndex, entries: [entry] });
    this.batchTimer ??= setTimeout(() => this.flush(), OUTPUT_BATCH_MS);
  }

  /** Emite agora todos os lotes pendentes. */
  flush(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    const batches = [...this.pending.values()];
    this.pending.clear();
    for (const batch of batches) this.send({ type: "step.output", ...batch });
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  /** Fecha as conexões abertas (usado no shutdown). */
  close(): Promise<void> {
    this.flush();
    for (const client of this.wss.clients) client.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  /** Envia a todos os clientes abertos. */
  private send(event: ServerEvent): void {
    const payload = JSON.stringify(ServerEventSchema.parse(event));
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  private sendTo(ws: WebSocket, event: ServerEvent): void {
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
