import { execFile } from "node:child_process";

const POSIX_GRACE_MS = 2000;

/**
 * Encerra o processo `pid` e todos os seus descendentes (research R5, SC-005).
 * - Windows: `taskkill /PID <pid> /T /F` (árvore inteira, imediato).
 * - POSIX: o processo foi iniciado com `detached: true` (líder de grupo): `SIGTERM` no grupo e,
 *   se ele não sair em 2 s, `SIGKILL`.
 * Processo já encerrado não é erro. Nunca rejeita.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }

  if (!signalGroup(pid, "SIGTERM")) return;
  const deadline = Date.now() + POSIX_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!groupAlive(pid)) return;
  }
  signalGroup(pid, "SIGKILL");
}

/** `false` se o grupo não existe mais. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // Sem grupo (processo não era líder): tenta o próprio processo.
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
