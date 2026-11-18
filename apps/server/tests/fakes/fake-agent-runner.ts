import type { OutputEntry, Usage } from "@orchestrator/shared";
import type { AgentInvocation, AgentOutcome, AgentRunner } from "../../src/agent/agent-runner.js";

/** Roteiro de uma chamada do `FakeAgentRunner` (contracts/agent-runner.md, "FakeAgentRunner"). */
export interface FakeScript {
  /** Entradas emitidas via `onOutput`, em ordem, antes do atraso. */
  outputs?: Array<Omit<OutputEntry, "seq" | "at">>;
  /** Espera (ms) entre uma entrada de `outputs` e a seguinte (saída espaçada, como o agente real). Padrão 0. */
  outputIntervalMs?: number;
  /** Simula o trabalho do agente no repositório; roda antes de resolver, inclusive se interrompido. */
  sideEffect?: (cwd: string) => Promise<void>;
  /** Atraso (ms) via `setTimeout`, controlável por `vi.useFakeTimers()`. Padrão 0. */
  delayMs?: number;
  /** Padrão `success`. */
  result?: "success" | "error";
  errorMessage?: string;
  usage?: Usage | null;
  sessionCostUsd?: number | null;
}

export type RecordedInvocation = Omit<AgentInvocation, "signal" | "onOutput" | "cwd"> & { cwd: string };

/**
 * Runner programável para testes do executor. Cada chamada consome o próximo roteiro da fila
 * (ou o roteiro padrão quando a fila acaba) e registra a invocação recebida.
 */
export class FakeAgentRunner implements AgentRunner {
  readonly invocations: RecordedInvocation[] = [];
  /** Cada entrada efetivamente entregue a `onOutput`, com o instante (`Date.now()`) da emissão. */
  readonly emitted: Array<{ text: string; at: number }> = [];
  private readonly queue: FakeScript[];

  constructor(scripts: FakeScript[] = [], private readonly fallback: FakeScript = {}) {
    this.queue = [...scripts];
  }

  /** Acrescenta roteiros para as próximas chamadas. */
  enqueue(...scripts: FakeScript[]): void {
    this.queue.push(...scripts);
  }

  async run(invocation: AgentInvocation): Promise<AgentOutcome> {
    const { signal, onOutput, ...recorded } = invocation;
    this.invocations.push(recorded);
    const script = this.queue.shift() ?? this.fallback;
    const usage = script.usage ?? null;
    const sessionCostUsd = script.sessionCostUsd ?? null;
    const startedAt = Date.now();

    let open = true;
    const emit: AgentInvocation["onOutput"] = (entry) => {
      if (!open) return;
      this.emitted.push({ text: entry.text, at: Date.now() });
      onOutput(entry);
    };

    try {
      let first = true;
      for (const entry of script.outputs ?? []) {
        if (!first && script.outputIntervalMs && (await waitOrAbort(script.outputIntervalMs, signal))) break;
        first = false;
        if (signal.aborted) break;
        emit(entry);
      }
      const aborted = await waitOrAbort(script.delayMs ?? 0, signal);
      if (script.sideEffect) await script.sideEffect(invocation.cwd);
      const durationMs = Date.now() - startedAt;
      if (aborted || signal.aborted) return { kind: "interrupted", usage, sessionCostUsd, durationMs };
      if (script.result === "error") {
        return {
          kind: "error",
          message: script.errorMessage ?? "Falha simulada do agente",
          usage,
          sessionCostUsd,
          durationMs,
        };
      }
      return { kind: "success", usage, sessionCostUsd, durationMs };
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        usage,
        sessionCostUsd,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      open = false;
    }
  }
}

/** Resolve `true` se o sinal for abortado antes do fim do atraso. */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
