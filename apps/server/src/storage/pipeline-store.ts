import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createDefaultPipeline,
  PipelineInputSchema,
  PipelineSchema,
  type ApiIssue,
  type Pipeline,
  type PipelineInput,
} from "@orchestrator/shared";
import { ApiError } from "../http/errors.js";
import { atomicWriteJson } from "./atomic-write.js";
import { ensureDataDirs, resolveDataDir } from "./data-dir.js";
import { isNotFound, isSafeId, toApiIssues } from "./fs-utils.js";

type ReadResult = { ok: true; pipeline: Pipeline } | { ok: false; path: string; error: ApiError };

/** Esteiras em `pipelines/<id>.json`, validadas pelo `PipelineSchema` ao ler e gravar (data-model.md §1). */
export class PipelineStore {
  private readonly dir: string;

  constructor(private readonly dataDir: string = resolveDataDir()) {
    this.dir = join(dataDir, "pipelines");
  }

  /** Grava a esteira padrão se `pipelines/` estiver vazia (FR-020). */
  async init(): Promise<void> {
    await ensureDataDirs(this.dataDir);
    if ((await this.files()).length > 0) return;
    await this.write(createDefaultPipeline(new Date().toISOString()));
  }

  /** Padrão primeiro, depois por nome. Arquivos inválidos são ignorados com aviso. */
  async list(): Promise<Pipeline[]> {
    const pipelines: Pipeline[] = [];
    for (const file of await this.files()) {
      const result = await this.read(join(this.dir, file));
      if (result.ok) pipelines.push(result.pipeline);
      else {
        console.warn(
          `[pipeline-store] esteira inválida ignorada: ${result.path}`,
          JSON.stringify(result.error.issues),
        );
      }
    }
    return pipelines.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name, "pt-BR");
    });
  }

  /** `404 NOT_FOUND` se não existir; `422 PIPELINE_INVALID` (com `issues`) se o arquivo for inválido. */
  async get(id: string): Promise<Pipeline> {
    const result = await this.read(this.pathFor(id));
    if (!result.ok) throw result.error;
    return result.pipeline;
  }

  async create(input: PipelineInput): Promise<Pipeline> {
    const parsed = PipelineInputSchema.parse(input);
    const now = new Date().toISOString();
    const pipeline = PipelineSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      name: parsed.name,
      isDefault: false,
      steps: withStepIds(parsed.steps),
      createdAt: now,
      updatedAt: now,
    });
    await this.write(pipeline);
    return pipeline;
  }

  async update(id: string, input: PipelineInput): Promise<Pipeline> {
    const current = await this.get(id);
    const parsed = PipelineInputSchema.parse(input);
    const pipeline = PipelineSchema.parse({
      ...current,
      name: parsed.name,
      steps: withStepIds(parsed.steps),
      updatedAt: new Date().toISOString(),
    });
    await this.write(pipeline);
    return pipeline;
  }

  /** `409 INVALID_STATE` para a esteira padrão (contracts/rest-api.md). */
  async delete(id: string): Promise<void> {
    const pipeline = await this.get(id);
    if (pipeline.isDefault) {
      throw new ApiError(409, "INVALID_STATE", "A esteira padrão não pode ser excluída");
    }
    await rm(this.pathFor(id));
  }

  /** Compara após `trim`, sem diferenciar maiúsculas; `exceptId` permite manter o nome da própria esteira. */
  async nameExists(name: string, exceptId?: string): Promise<boolean> {
    const wanted = normalizeName(name);
    return (await this.list()).some((pipeline) => pipeline.id !== exceptId && normalizeName(pipeline.name) === wanted);
  }

  private pathFor(id: string): string {
    if (!isSafeId(id)) throw notFound();
    return join(this.dir, `${id}.json`);
  }

  private async files(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async write(pipeline: Pipeline): Promise<void> {
    await ensureDataDirs(this.dataDir);
    await atomicWriteJson(join(this.dir, `${pipeline.id}.json`), pipeline);
  }

  private async read(path: string): Promise<ReadResult> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) throw notFound();
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return invalid(path, [{ path: [], message: "O arquivo não contém JSON válido" }]);
    }
    const parsed = PipelineSchema.safeParse(json);
    if (!parsed.success) return invalid(path, toApiIssues(parsed.error));
    return { ok: true, pipeline: parsed.data };
  }
}

function withStepIds(steps: PipelineInput["steps"]): Pipeline["steps"] {
  return steps.map((step) => ({ ...step, id: step.id ?? randomUUID() }));
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase("pt-BR");
}

function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Esteira não encontrada");
}

function invalid(path: string, issues: ApiIssue[]): ReadResult {
  return {
    ok: false,
    path,
    error: new ApiError(422, "PIPELINE_INVALID", "O arquivo da esteira é inválido", issues),
  };
}
