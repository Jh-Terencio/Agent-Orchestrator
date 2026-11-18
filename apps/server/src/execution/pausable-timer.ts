export interface PausableTimer {
  /** Cancela o disparo e guarda o tempo restante. Idempotente. */
  pause(): void;
  /** Agenda de novo com o tempo restante. Idempotente; não faz nada depois de `clear` ou do disparo. */
  resume(): void;
  /** Cancela de vez. */
  clear(): void;
  remainingMs(): number;
}

/**
 * Limite de tempo de uma invocação que pode ser pausado enquanto o passo espera uma decisão de
 * permissão (FR-032, research R13). Usa `setTimeout` e `performance.now()` para os fake timers do Vitest controlarem (R4).
 */
export function createPausableTimer(ms: number, onFire: () => void): PausableTimer {
  let remaining = ms;
  let startedAt = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const schedule = (): void => {
    startedAt = performance.now();
    handle = setTimeout(() => {
      handle = null;
      done = true;
      remaining = 0;
      onFire();
    }, remaining);
  };

  schedule();
  return {
    pause() {
      if (handle === null) return;
      clearTimeout(handle);
      handle = null;
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
    },
    resume() {
      if (handle !== null || done) return;
      schedule();
    },
    clear() {
      if (handle !== null) clearTimeout(handle);
      handle = null;
      done = true;
    },
    remainingMs() {
      return handle === null ? remaining : Math.max(0, remaining - (performance.now() - startedAt));
    },
  };
}
