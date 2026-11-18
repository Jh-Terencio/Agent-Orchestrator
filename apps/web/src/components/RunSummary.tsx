import { computeRunTotals, type PermissionRequest, type Run } from "@orchestrator/shared";
import { formatDuration, formatUsage, PERMISSION_STATUS_LABELS, RUN_STATUS_LABELS } from "../format";

function decisionText(request: PermissionRequest): string {
  const label = PERMISSION_STATUS_LABELS[request.status];
  return request.status === "allowed_always" && request.rule !== null ? `${label} (${request.rule})` : label;
}

/** Resultado da execução (FR-017), totais (FR-017a, Princípio VIII) e permissões (FR-027/FR-031). */
export function RunSummary({ run }: { run: Run }) {
  const totals = computeRunTotals(run);
  const usageText = formatUsage(totals.usage);
  const requests = run.steps.flatMap((step) => step.permissionRequests);
  return (
    <section className="run-summary" aria-label="Resumo da execução">
      <p>
        <strong className={`run-status run-status-${run.status}`}>{RUN_STATUS_LABELS[run.status]}</strong>
        {run.yolo && <span className="yolo-badge">Modo Yolo</span>}
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
      {requests.length > 0 && (
        <div>
          <span>Pedidos de permissão:</span>
          <ul aria-label="Pedidos de permissão" className="permission-list">
            {requests.map((request) => (
              <li key={request.id}>
                <code>{request.summary}</code> — {decisionText(request)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
