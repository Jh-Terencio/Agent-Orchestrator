import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Pasta de dados do orquestrador, fora do repositório alvo (research R8). */
export function resolveDataDir(): string {
  const override = process.env.ORCHESTRATOR_DATA_DIR;
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "agent-orchestrator");
  }
  return join(homedir(), ".local", "share", "agent-orchestrator");
}

export async function ensureDataDirs(dataDir: string = resolveDataDir()): Promise<void> {
  await mkdir(join(dataDir, "pipelines"), { recursive: true });
  await mkdir(join(dataDir, "runs"), { recursive: true });
}
