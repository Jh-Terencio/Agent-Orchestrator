import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OutputEntrySchema, RunSchema, type OutputEntry, type Run } from "@orchestrator/shared";
import { ApiError } from "../http/errors.js";
import { atomicWriteJson } from "./atomic-write.js";
import { resolveDataDir } from "./data-dir.js";
import { isNotFound, isSafeId } from "./fs-utils.js";

/**
 * Execuções em `runs/<runId>/run.json` (gravação atômica) e saída de cada passo em
 * `runs/<runId>/<stepIndex>.output.jsonl` (append-only, uma entrada por linha; research R8).
 */
export class RunStore {
  private readonly dir: string;
  /** Último `seq` emitido por `runId:stepIndex`. */
  private readonly lastSeq = new Map<string, number>();

  constructor(dataDir: string = resolveDataDir()) {
    this.dir = join(dataDir, "runs");
  }

  async save(run: Run): Promise<void> {
    const parsed = RunSchema.parse(run);
    const runDir = this.runDir(parsed.id);
    await mkdir(runDir, { recursive: true });
    await atomicWriteJson(join(runDir, "run.json"), parsed);
  }

  /** `404 NOT_FOUND` se não existir. */
  async get(id: string): Promise<Run> {
    let raw: string;
    try {
      raw = await readFile(join(this.runDir(id), "run.json"), "utf8");
    } catch (error) {
      if (isNotFound(error)) throw notFound();
      throw error;
    }
    return RunSchema.parse(JSON.parse(raw));
  }

  /** Lê todos os `run.json`; registros ilegíveis ou inválidos são ignorados com aviso. */
  async listAll(): Promise<Run[]> {
    let ids: string[];
    try {
      ids = await readdir(this.dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const runs: Run[] = [];
    for (const id of ids) {
      const path = join(this.dir, id, "run.json");
      try {
        runs.push(RunSchema.parse(JSON.parse(await readFile(path, "utf8"))));
      } catch (error) {
        if (isNotFound(error)) continue;
        console.warn(
          `[run-store] execução inválida ignorada: ${path}`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return runs;
  }

  async appendOutput(runId: string, stepIndex: number, entries: readonly OutputEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const path = this.outputPath(runId, stepIndex);
    await mkdir(this.runDir(runId), { recursive: true });
    const lines = entries.map((entry) => `${JSON.stringify(OutputEntrySchema.parse(entry))}\n`).join("");
    await appendFile(path, lines, "utf8");
  }

  /** Entradas do passo com `seq > afterSeq` (todas, se `afterSeq` for omitido). */
  async readOutput(runId: string, stepIndex: number, afterSeq?: number): Promise<OutputEntry[]> {
    const entries = await this.readAllOutput(runId, stepIndex);
    return afterSeq === undefined ? entries : entries.filter((entry) => entry.seq > afterSeq);
  }

  /** Próximo `seq` do passo: monotônico a partir de 1, continuando do maior `seq` já gravado. */
  async nextSeq(runId: string, stepIndex: number): Promise<number> {
    const key = `${runId}:${stepIndex}`;
    let last = this.lastSeq.get(key);
    if (last === undefined) {
      const entries = await this.readAllOutput(runId, stepIndex);
      last = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    }
    const next = last + 1;
    this.lastSeq.set(key, next);
    return next;
  }

  private async readAllOutput(runId: string, stepIndex: number): Promise<OutputEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.outputPath(runId, stepIndex), "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => OutputEntrySchema.parse(JSON.parse(line)));
  }

  private runDir(id: string): string {
    if (!isSafeId(id)) throw notFound();
    return join(this.dir, id);
  }

  private outputPath(runId: string, stepIndex: number): string {
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      throw new ApiError(404, "NOT_FOUND", "Passo não encontrado");
    }
    return join(this.runDir(runId), `${stepIndex}.output.jsonl`);
  }
}

function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Execução não encontrada");
}
