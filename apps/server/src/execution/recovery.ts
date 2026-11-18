import type { RunStatus, StepStatus } from "@orchestrator/shared";
import type { RunStore } from "../storage/run-store.js";

const ACTIVE_RUN = new Set<RunStatus>(["running", "awaiting_input", "awaiting_permission"]);
const ACTIVE_STEP = new Set<StepStatus>(["running", "awaiting_input", "awaiting_permission"]);

/**
 * Recuperação na inicialização (research R8): o processo pode ter morrido sem passar pelo shutdown
 * gracioso. Todo run não terminal vira `interrupted`, com o passo em andamento `interrupted` por
 * `server_shutdown` e os pedidos de permissão pendentes `cancelled`. Nada é reexecutado (FR-019). Devolve os ids recuperados.
 */
export async function recoverInterruptedRuns(
  runStore: RunStore,
  clock: () => Date = () => new Date(),
): Promise<string[]> {
  const recovered: string[] = [];
  for (const run of await runStore.listAll()) {
    if (!ACTIVE_RUN.has(run.status)) continue;
    const now = clock().toISOString();
    for (const step of run.steps) {
      if (!ACTIVE_STEP.has(step.status)) continue;
      step.status = "interrupted";
      step.interruptReason = "server_shutdown";
      step.finishedAt = now;
      // Pedidos de permissão sem decisão: o processo do agente já não existe (research R13).
      for (const request of step.permissionRequests) {
        if (request.status !== "pending") continue;
        request.status = "cancelled";
        request.decidedAt = now;
      }
    }
    run.status = "interrupted";
    run.finishedAt = now;
    try {
      await runStore.save(run);
      recovered.push(run.id);
    } catch (error) {
      console.warn(`[recovery] não foi possível marcar a execução ${run.id} como interrompida:`, error);
    }
  }
  return recovered;
}
