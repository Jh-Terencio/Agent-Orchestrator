import { Router } from "express";
import { PipelineInputSchema, type Pipeline, type PipelineInput } from "@orchestrator/shared";
import type { PipelineStore } from "../../storage/pipeline-store.js";
import { ApiError, fromZodError } from "../errors.js";

const NAME_TAKEN_MESSAGE = "Já existe uma esteira com este nome";
const MAX_PIPELINE_NAME = 80;

function nameTaken(): ApiError {
  return new ApiError(400, "VALIDATION_FAILED", "Dados da esteira inválidos", [
    { path: ["name"], message: NAME_TAKEN_MESSAGE },
  ]);
}

function parseInput(body: unknown): PipelineInput {
  const parsed = PipelineInputSchema.safeParse(body);
  if (!parsed.success) throw fromZodError(parsed.error, "Dados da esteira inválidos");
  return parsed.data;
}

/** "<nome> (cópia)", "<nome> (cópia 2)"… cortando o nome base para caber em 80 caracteres. */
async function copyName(store: PipelineStore, original: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? " (cópia)" : ` (cópia ${attempt})`;
    const name = `${original.slice(0, MAX_PIPELINE_NAME - suffix.length).trimEnd()}${suffix}`;
    if (!(await store.nameExists(name))) return name;
  }
}

/** CRUD de esteiras (contracts/rest-api.md, "Esteiras"; FR-021–FR-025). */
export function pipelinesRouter(pipelineStore: PipelineStore): Router {
  const router = Router();

  router.get("/pipelines", async (_req, res) => {
    res.json(await pipelineStore.list());
  });

  // 404 se não existir; 422 PIPELINE_INVALID (com issues) se o arquivo for inválido.
  router.get("/pipelines/:id", async (req, res) => {
    res.json(await pipelineStore.get(req.params.id));
  });

  router.post("/pipelines", async (req, res) => {
    const input = parseInput(req.body);
    if (await pipelineStore.nameExists(input.name)) throw nameTaken();
    res.status(201).json(await pipelineStore.create(input));
  });

  router.put("/pipelines/:id", async (req, res) => {
    const input = parseInput(req.body);
    await pipelineStore.get(req.params.id); // 404 antes de checar o nome
    if (await pipelineStore.nameExists(input.name, req.params.id)) throw nameTaken();
    res.json(await pipelineStore.update(req.params.id, input));
  });

  router.post("/pipelines/:id/duplicate", async (req, res) => {
    const original: Pipeline = await pipelineStore.get(req.params.id);
    const copy = await pipelineStore.create({
      name: await copyName(pipelineStore, original.name),
      // Sem `id`: a cópia recebe ids de passo novos.
      steps: original.steps.map(({ id: _id, ...step }) => step),
    });
    res.status(201).json(copy);
  });

  // 409 INVALID_STATE para a esteira padrão.
  router.delete("/pipelines/:id", async (req, res) => {
    await pipelineStore.delete(req.params.id);
    res.status(204).end();
  });

  return router;
}
