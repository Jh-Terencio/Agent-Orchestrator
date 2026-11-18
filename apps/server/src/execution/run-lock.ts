import { ApiError } from "../http/errors.js";

/** Trava de execução única (FR-012): no máximo uma execução ativa por servidor. */
export class RunLock {
  private current: string | null = null;

  get activeRunId(): string | null {
    return this.current;
  }

  /** Lança `409 RUN_ALREADY_ACTIVE` se já houver uma execução ativa. */
  acquire(runId: string): void {
    if (this.current !== null) throw runAlreadyActive(this.current);
    this.current = runId;
  }

  /** Libera só se `runId` for o dono da trava. */
  release(runId: string): void {
    if (this.current === runId) this.current = null;
  }
}

export function runAlreadyActive(activeRunId: string): ApiError {
  return new ApiError(
    409,
    "RUN_ALREADY_ACTIVE",
    "Já existe uma execução em andamento. Aguarde o fim ou interrompa-a antes de iniciar outra.",
    undefined,
    { activeRunId },
  );
}
