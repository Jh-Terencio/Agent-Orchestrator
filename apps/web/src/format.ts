import type { RepoProblem, RunStatus, StepStatus, Usage } from "@orchestrator/shared";

export const PROBLEM_LABELS: Record<RepoProblem, string> = {
  not_a_repo: "A pasta não é um repositório Git",
  dirty_worktree: "Há alterações não commitadas",
  merge_or_rebase_in_progress: "Há merge/rebase em andamento",
  detached_head: "HEAD destacado: troque para uma branch",
  path_not_found: "Pasta não encontrada",
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  waiting: "aguardando",
  running: "executando",
  awaiting_input: "aguardando resposta",
  completed: "concluído",
  failed: "com erro",
  interrupted: "interrompido",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Em andamento",
  awaiting_input: "Aguardando resposta",
  completed: "Concluída",
  failed: "Com erro",
  interrupted: "Interrompida",
};

/** `mm:ss` (os minutos passam de 59 em execuções longas). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const integer = new Intl.NumberFormat("pt-BR");
const dollars = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const count = (value: number | null): string => (value === null ? "—" : integer.format(value));

/** "1.500 entrada / 300 saída · US$ 0,1370", ou `null` se nada foi reportado. */
export function formatUsage(usage: Usage | null): string | null {
  if (usage === null) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== null || usage.outputTokens !== null) {
    parts.push(`Tokens: ${count(usage.inputTokens)} entrada / ${count(usage.outputTokens)} saída`);
  }
  if (usage.costUsd !== null) parts.push(`Custo: US$ ${dollars.format(usage.costUsd)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
