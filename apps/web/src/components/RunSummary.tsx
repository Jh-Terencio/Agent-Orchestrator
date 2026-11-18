import { computeRunTotals, type Run } from "@orchestrator/shared";
import { formatDuration, formatUsage, RUN_STATUS_LABELS } from "../format";

/** Resultado da execução (FR-017) e totais de duração e consumo (FR-017a, Princípio VIII). */
export function RunSummary({ run }: { run: Run }) {
  const totals = computeRunTotals(run);
  const usageText = formatUsage(totals.usage);
  return (
    <section className="run-summary" aria-label="Resumo da execução">
      <p>
        <strong className={`run-status run-status-${run.status}`}>{RUN_STATUS_LABELS[run.status]}</strong>
      </p>
      {run.finalBranch !== null && (
        <p>
          <span>Branch final:</span> <code>{run.finalBranch}</code>
        </p>
      )}
      <div>
        <span>Branches criadas:</span>
        <ul aria-label="Branches criadas">
          {run.createdBranches.map((branch) => (
            <li key={branch}>
              <code>{branch}</code>
            </li>
          ))}
        </ul>
      </div>
      <p>Duração total: {totals.durationMs === null ? "—" : formatDuration(totals.durationMs)}</p>
      <p>Consumo: {usageText ?? "consumo indisponível"}</p>
    </section>
  );
}
