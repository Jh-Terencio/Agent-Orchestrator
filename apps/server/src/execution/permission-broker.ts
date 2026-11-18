import { randomBytes } from "node:crypto";
import type { PermissionChannel, RelayDecision } from "../agent/agent-runner.js";

export interface PermissionCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
}

/** Decide um pedido de permissão de uma invocação (implementado pelo executor). */
export type PermissionHandler = (req: PermissionCall) => Promise<RelayDecision>;

export const INTERNAL_PERMISSION_PATH = "/internal/permission-requests";
export const UNKNOWN_TOKEN_MESSAGE = "Pedido de permissão sem invocação ativa do agente; comando negado.";
export const CHANNEL_CLOSED_MESSAGE = "A invocação do agente terminou antes da decisão.";
export const HANDLER_FAILED_MESSAGE = "Erro no orquestrador ao registrar o pedido de permissão; comando negado.";

interface Channel {
  handler: PermissionHandler;
  /** Resolvedores dos pedidos ainda sem resposta: o fechamento do canal nega todos. */
  pending: Set<(decision: RelayDecision) => void>;
}

/**
 * Liga o token de cada invocação do agente ao handler do executor (research R13). Um pedido só é
 * atendido enquanto o canal da invocação está aberto; tudo o mais nega (falha fechada, FR-031).
 */
export class PermissionBroker {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly getBaseUrl: () => string) {}

  openChannel(handler: PermissionHandler): PermissionChannel {
    const token = randomBytes(32).toString("hex");
    this.channels.set(token, { handler, pending: new Set() });
    return { url: `${this.getBaseUrl()}${INTERNAL_PERMISSION_PATH}`, token };
  }

  /** Fecha o canal: pedidos seguintes e pendentes são negados. */
  closeChannel(token: string): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    this.channels.delete(token);
    for (const resolve of channel.pending) resolve({ behavior: "deny", message: CHANNEL_CLOSED_MESSAGE });
    channel.pending.clear();
  }

  hasChannel(token: string): boolean {
    return this.channels.has(token);
  }

  /** Nunca rejeita. */
  request(token: string, req: PermissionCall): Promise<RelayDecision> {
    const channel = this.channels.get(token);
    if (!channel) return Promise.resolve({ behavior: "deny", message: UNKNOWN_TOKEN_MESSAGE });
    return new Promise<RelayDecision>((resolve) => {
      let done = false;
      const settle = (decision: RelayDecision): void => {
        if (done) return;
        done = true;
        channel.pending.delete(settle);
        resolve(decision);
      };
      channel.pending.add(settle);
      let result: Promise<RelayDecision>;
      try {
        result = channel.handler(req);
      } catch (error) {
        result = Promise.reject(error);
      }
      result.then(settle, (error: unknown) => {
        console.error("[permissões] falha ao tratar o pedido:", error);
        settle({ behavior: "deny", message: HANDLER_FAILED_MESSAGE });
      });
    });
  }
}
