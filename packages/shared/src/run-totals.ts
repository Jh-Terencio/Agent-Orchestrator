import type { StepRun, Usage } from "./schemas/run.js";

/** Totais derivados de uma execução (FR-017a, data-model.md §4a). Não são persistidos. */
export interface RunTotals {
  durationMs: number | null;
  usage: Usage | null;
}

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "costUsd",
  "numTurns",
] as const satisfies readonly (keyof Usage)[];

function sumNonNull(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

/** Soma duração e consumo dos passos; campos que nenhum passo reportou ficam `null`. */
export function computeRunTotals(run: { readonly steps: readonly Pick<StepRun, "durationMs" | "usage">[] }): RunTotals {
  const durationMs = sumNonNull(run.steps.map((step) => step.durationMs));

  const usages = run.steps.flatMap((step) => (step.usage === null ? [] : [step.usage]));
  if (usages.length === 0) return { durationMs, usage: null };

  const usage = Object.fromEntries(
    USAGE_KEYS.map((key) => [key, sumNonNull(usages.map((u) => u[key]))]),
  ) as Usage;
  return { durationMs, usage };
}
