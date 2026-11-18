import type { OutputEntry, Usage } from "@orchestrator/shared";

/** Fronteira entre o executor e a ferramenta de agente (contracts/agent-runner.md, research R1). */
export interface AgentInvocation {
  /** Repositório alvo. */
  cwd: string;
  /** Ex.: "/speckit-specify <descrição>" ou a resposta do usuário. */
  prompt: string;
  /** Alias ou id completo. */
  model: string;
  /** uuid; nova sessão na 1ª chamada. */
  sessionId: string;
  /** true → continua `sessionId` (resposta de passo interativo). */
  resume: boolean;
  /** false → instrui o agente a não fazer perguntas (FR-006a). */
  interactive: boolean;
  /** `total_cost_usd` bruto da invocação anterior da mesma sessão; 0 quando `resume = false`; null se desconhecido (research R1). */
  priorSessionCostUsd: number | null;
  /** AbortController do executor; reason = "user" | "timeout" | "server_shutdown". */
  signal: AbortSignal;
  onOutput: (entry: Omit<OutputEntry, "seq" | "at">) => void;
}

// usage.costUsd é o custo desta invocação (não o acumulado da sessão).
// sessionCostUsd é o total_cost_usd bruto do result (acumulado na sessão), guardado para calcular a próxima diferença.
export type AgentOutcome =
  | { kind: "success"; usage: Usage | null; sessionCostUsd: number | null; durationMs: number }
  | { kind: "error"; message: string; usage: Usage | null; sessionCostUsd: number | null; durationMs: number }
  | { kind: "interrupted"; usage: Usage | null; sessionCostUsd: number | null; durationMs: number };

export interface AgentRunner {
  /** Nunca rejeita; erros viram `{ kind: "error" }`. */
  run(invocation: AgentInvocation): Promise<AgentOutcome>;
}
