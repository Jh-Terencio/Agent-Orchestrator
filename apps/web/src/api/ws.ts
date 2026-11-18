import { ServerEventSchema, type ServerEvent } from "@orchestrator/shared";

export type ConnectionStatus = "connected" | "reconnecting";

const MAX_BACKOFF_MS = 5_000;
const INITIAL_BACKOFF_MS = 250;

function eventsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Conecta em `/ws`, valida cada mensagem com `ServerEventSchema` e reconecta com backoff exponencial
 * (até 5 s). Depois de reconectar, o servidor envia `hello` de novo. Retorna a função que encerra a conexão.
 */
export function connectEvents(
  onEvent: (event: ServerEvent) => void,
  onStatus: (status: ConnectionStatus) => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let backoff = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const open = (): void => {
    socket = new WebSocket(eventsUrl());
    socket.onopen = () => {
      backoff = INITIAL_BACKOFF_MS;
      onStatus("connected");
    };
    socket.onmessage = (message: MessageEvent) => {
      let json: unknown;
      try {
        json = JSON.parse(String(message.data));
      } catch {
        console.warn("[ws] mensagem não é JSON; ignorada");
        return;
      }
      const parsed = ServerEventSchema.safeParse(json);
      if (parsed.success) onEvent(parsed.data);
      else console.warn("[ws] evento inválido ignorado", parsed.error.issues);
    };
    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      onStatus("reconnecting");
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
  };

  open();
  return () => {
    stopped = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    const current = socket;
    if (current === null) return;
    current.onmessage = null;
    if (current.readyState === WebSocket.CONNECTING) {
      // Fechar durante o handshake aborta o socket, e o proxy do Vite registra `ECONNABORTED`
      // (acontece em dev porque o StrictMode monta e desmonta o efeito). Fecha assim que abrir.
      current.onopen = () => current.close();
    } else {
      current.close();
    }
  };
}
