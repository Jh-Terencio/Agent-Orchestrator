import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SettingsSchema, type Settings } from "@orchestrator/shared";
import { atomicWriteJson } from "./atomic-write.js";
import { resolveDataDir } from "./data-dir.js";
import { isNotFound } from "./fs-utils.js";

const MAX_RECENT_REPOS = 10;

function emptySettings(): Settings {
  return { recentRepos: [], lastPipelineId: null };
}

/** Preferências em `settings.json` (data-model.md §7). */
export class SettingsStore {
  private readonly path: string;

  constructor(private readonly dataDir: string = resolveDataDir()) {
    this.path = join(dataDir, "settings.json");
  }

  /** Arquivo ausente → valores padrão; arquivo inválido → valores padrão com aviso. */
  async get(): Promise<Settings> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return emptySettings();
      throw error;
    }
    try {
      return SettingsSchema.parse(JSON.parse(raw));
    } catch (error) {
      console.warn(
        `[settings-store] settings.json inválido ignorado: ${this.path}`,
        error instanceof Error ? error.message : error,
      );
      return emptySettings();
    }
  }

  /** Mais recente primeiro, sem duplicatas, no máximo 10. */
  async addRecentRepo(repoPath: string): Promise<Settings> {
    const current = await this.get();
    const recentRepos = [repoPath, ...current.recentRepos.filter((item) => item !== repoPath)].slice(
      0,
      MAX_RECENT_REPOS,
    );
    return this.write({ ...current, recentRepos });
  }

  async setLastPipelineId(id: string | null): Promise<Settings> {
    return this.write({ ...(await this.get()), lastPipelineId: id });
  }

  private async write(settings: Settings): Promise<Settings> {
    const parsed = SettingsSchema.parse(settings);
    await mkdir(this.dataDir, { recursive: true });
    await atomicWriteJson(this.path, parsed);
    return parsed;
  }
}
