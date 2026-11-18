import { StringDecoder } from "node:string_decoder";
import type { OutputEntry, Usage } from "@orchestrator/shared";

export type ParsedEntry = Omit<OutputEntry, "seq" | "at">;

export const AUTH_ERROR_MESSAGE =
  "Claude Code não está autenticado. Rode `claude` num terminal e faça `/login` com a sua assinatura.";

/** Resultado do evento `result` da CLI (contracts/agent-runner.md). */
export interface StreamJsonResult {
  isError: boolean;
  /** Texto final (`result`) ou mensagem de erro já traduzida em ação. */
  message: string | null;
  /** Consumo **desta invocação** (research R1). */
  usage: Usage | null;
  /** `total_cost_usd` bruto, acumulado na sessão. */
  sessionCostUsd: number | null;
  sessionId: string | null;
}

export interface StreamJsonParserOptions {
  onOutput: (entry: ParsedEntry) => void;
  /** `total_cost_usd` da invocação anterior da mesma sessão; 0 na 1ª; null se desconhecido. */
  priorSessionCostUsd: number | null;
}

export interface StreamJsonParser {
  /** Recebe um chunk bruto do stdout. */
  push(chunk: Buffer): void;
  /** Processa o que restou no buffer (fim do stream). */
  end(): void;
  getResult(): StreamJsonResult | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const SUMMARY_MAX = 200;

/** Resumo de uma chamada de ferramenta: o campo mais informativo da entrada. */
function summarizeToolInput(input: unknown): string {
  if (!isObject(input)) return "";
  for (const key of ["command", "file_path", "path", "pattern", "skill", "url", "description"]) {
    const value = str(input[key]);
    if (value) return truncate(value);
  }
  return truncate(JSON.stringify(input));
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) ? (str(part.text) ?? (part.type === "image" ? "[imagem]" : "")) : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

/** Regra de research R1 para o custo da invocação. */
function invocationCost(event: Json, priorSessionCostUsd: number | null): number | null {
  const sinceLast = event.model_usage_since_last_result;
  if (isObject(sinceLast)) {
    let total = 0;
    for (const model of Object.values(sinceLast)) {
      if (isObject(model)) total += num(model.costUSD) ?? 0;
    }
    return total;
  }
  const total = num(event.total_cost_usd);
  if (total === null || priorSessionCostUsd === null) return null;
  return Math.max(0, total - priorSessionCostUsd);
}

function isAuthError(event: Json, assistantError: string | null): boolean {
  if (assistantError === "authentication_failed") return true;
  const text = str(event.result) ?? "";
  return /not logged in|please run \/login|invalid api key|authentication/i.test(text);
}

/**
 * Converte o stdout `stream-json` do Claude Code em `OutputEntry`s (research R10).
 * Decodifica com um `StringDecoder` próprio antes de separar as linhas, para não corromper
 * caracteres multibyte divididos entre chunks. Nunca lança por causa do conteúdo da linha.
 */
export function createStreamJsonParser(options: StreamJsonParserOptions): StreamJsonParser {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let result: StreamJsonResult | null = null;
  let sessionId: string | null = null;
  let assistantError: string | null = null;
  /** Deltas de texto consecutivos do mesmo chunk viram uma única entrada. */
  let pendingText = "";

  const flushText = (): void => {
    if (pendingText) {
      options.onOutput({ kind: "text", text: pendingText });
      pendingText = "";
    }
  };
  const emit = (entry: ParsedEntry): void => {
    flushText();
    options.onOutput(entry);
  };

  const handle = (event: Json): void => {
    switch (event.type) {
      case "stream_event": {
        const inner = event.event;
        if (!isObject(inner) || inner.type !== "content_block_delta" || !isObject(inner.delta)) return;
        if (inner.delta.type !== "text_delta") return;
        pendingText += str(inner.delta.text) ?? "";
        return;
      }
      case "assistant": {
        if (typeof event.error === "string") assistantError = event.error;
        const message = event.message;
        if (!isObject(message) || !Array.isArray(message.content)) return;
        for (const block of message.content) {
          if (isObject(block) && block.type === "tool_use") {
            emit({ kind: "tool_use", text: `${str(block.name) ?? "Ferramenta"}: ${summarizeToolInput(block.input)}` });
          }
        }
        return;
      }
      case "user": {
        const message = event.message;
        if (!isObject(message) || !Array.isArray(message.content)) return;
        for (const block of message.content) {
          if (isObject(block) && block.type === "tool_result") {
            emit({ kind: "tool_result", text: toolResultText(block.content) });
          }
        }
        return;
      }
      case "system": {
        if (event.subtype !== "init") return;
        sessionId = str(event.session_id) ?? sessionId;
        emit({ kind: "system", text: `modelo ${str(event.model) ?? "?"}, sessão ${sessionId ?? "?"}` });
        return;
      }
      case "result": {
        flushText();
        const usage = isObject(event.usage) ? event.usage : {};
        const isError = event.is_error === true;
        const resultText = str(event.result);
        let message = resultText;
        if (isError) {
          message = isAuthError(event, assistantError)
            ? AUTH_ERROR_MESSAGE
            : resultText || `O agente terminou com erro (${str(event.subtype) ?? "desconhecido"})`;
        }
        sessionId = str(event.session_id) ?? sessionId;
        result = {
          isError,
          message,
          usage: {
            inputTokens: num(usage.input_tokens),
            outputTokens: num(usage.output_tokens),
            cacheReadTokens: num(usage.cache_read_input_tokens),
            cacheCreationTokens: num(usage.cache_creation_input_tokens),
            costUsd: invocationCost(event, options.priorSessionCostUsd),
            numTurns: num(event.num_turns),
          },
          sessionCostUsd: num(event.total_cost_usd),
          sessionId,
        };
        return;
      }
      default:
        return; // rate_limit_event e tipos desconhecidos
    }
  };

  const processLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // linha não JSON
    }
    if (isObject(event)) handle(event);
  };

  const drain = (): void => {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      processLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };

  return {
    push(chunk) {
      buffer += decoder.write(chunk);
      drain();
      flushText();
    },
    end() {
      buffer += decoder.end();
      drain();
      if (buffer) processLine(buffer);
      buffer = "";
      flushText();
    },
    getResult: () => result,
  };
}
