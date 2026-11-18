import type { OutputEntry, Usage } from "@orchestrator/shared";
import { request } from "node:http";
import type {
  AgentInvocation,
  AgentOutcome,
  AgentRunner,
  PermissionChannel,
  RelayDecision,
} from "../../src/agent/agent-runner.js";
import type { PermissionBroker } from "../../src/execution/permission-broker.js";

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
  /**
   * Pedidos de permissão enviados pelo broker (com o token de `permissionChannel`) depois das saídas e
   * antes do atraso. Ignorados no Modo Yolo (`permissionChannel === null`).
   */
  permissionRequests?: Array<{ toolName: string; input: Record<string, unknown> }>;
  /** `true` → envia todos ao mesmo tempo (`Promise.all`); senão, um depois do outro. */
  parallelPermissions?: boolean;
  /** `true` → envia os pedidos e não espera as decisões (simula a CLI que desiste de esperar). */
  abandonPermissions?: boolean;
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
  /** Decisões recebidas pelo broker, na ordem em que chegaram. */
  readonly permissionDecisions: RelayDecision[] = [];
  private readonly queue: FakeScript[];
  private toolUseCounter = 0;

  constructor(
    scripts: FakeScript[] = [],
    private readonly fallback: FakeScript = {},
    private readonly broker?: PermissionBroker,
  ) {
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
      await this.askPermissions(script, invocation);
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

  /**
   * Envia os pedidos do roteiro pelo broker ou, sem broker, por HTTP para `permissionChannel.url`, como o
   * relay real (testes de integração).
   */
  private async askPermissions(script: FakeScript, invocation: AgentInvocation): Promise<void> {
    const channel = invocation.permissionChannel;
    const requests = script.permissionRequests ?? [];
    if (channel === null || requests.length === 0 || invocation.signal.aborted) return;
    const broker = this.broker;
    const ask = (request: { toolName: string; input: Record<string, unknown> }): Promise<void> => {
      this.toolUseCounter += 1;
      const call = { ...request, toolUseId: `toolu_fake_${this.toolUseCounter}` };
      const pending = broker ? broker.request(channel.token, call) : postDecision(channel, call);
      return pending.then((decision) => {
        this.permissionDecisions.push(decision);
      });
    };
    if (script.abandonPermissions) {
      for (const request of requests) void ask(request);
      return;
    }
    if (script.parallelPermissions) {
      await Promise.all(requests.map(ask));
      return;
    }
    for (const request of requests) await ask(request);
  }
}

/** POST do pedido na rota interna, como o relay; falha → `deny`. */
function postDecision(channel: PermissionChannel, body: unknown): Promise<RelayDecision> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const deny = (): void => resolve({ behavior: "deny", message: "falha no canal (fake)" });
    const req = request(
      channel.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-orchestrator-token": channel.token,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return deny();
          resolve(JSON.parse(raw) as RelayDecision);
        });
      },
    );
    req.on("error", deny);
    req.end(payload);
  });
}

/** Resolve `true` se o sinal for abortado antes do fim do atraso. */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  // Sem atraso, não agenda timer: com `vi.useFakeTimers()` um `setTimeout(0)` só dispararia ao avançar o relógio.
  if (ms <= 0) return Promise.resolve(false);
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
