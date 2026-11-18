import { Router } from "express";
import { z } from "zod";
import { ReplyRequestSchema, StartRunRequestSchema } from "@orchestrator/shared";
import type { PipelineExecutor } from "../../execution/pipeline-executor.js";
import type { PipelineStore } from "../../storage/pipeline-store.js";
import type { RunStore } from "../../storage/run-store.js";
import { ApiError, fromZodError } from "../errors.js";

const OutputQuerySchema = z.object({
  afterSeq: z.coerce
    .number({ message: "afterSeq deve ser um número inteiro" })
    .int({ message: "afterSeq deve ser um número inteiro" })
    .optional(),
});

/** Execuções (contracts/rest-api.md, "Execuções"). */
export function runsRouter(executor: PipelineExecutor, pipelineStore: PipelineStore, runStore: RunStore): Router {
  const router = Router();

  router.post("/runs", async (req, res) => {
    const parsed = StartRunRequestSchema.safeParse(req.body);
    if (!parsed.success) throw fromZodError(parsed.error, "Dados de envio inválidos");
    const pipeline = await pipelineStore.get(parsed.data.pipelineId); // 404 / 422 PIPELINE_INVALID
    const run = await executor.start({ ...parsed.data, pipeline });
    res.status(201).json(run);
  });

  router.get("/runs/active", (_req, res) => {
    const run = executor.getActiveRun();
    if (run === null) res.status(204).end();
    else res.json(run);
  });

  router.get("/runs/:id", async (req, res) => {
    res.json(await executor.getRun(req.params.id));
  });

  // Saída completa ou incremental de um passo (FR-015/FR-016).
  router.get("/runs/:id/steps/:index/output", async (req, res) => {
    const run = await executor.getRun(req.params.id); // 404 se a execução não existir
    const raw = req.params.index;
    const index = /^\d+$/.test(raw) ? Number(raw) : -1;
    if (index < 0 || index >= run.steps.length) throw new ApiError(404, "NOT_FOUND", "Passo não encontrado");
    const query = OutputQuerySchema.safeParse(req.query);
    if (!query.success) throw fromZodError(query.error, "Parâmetros inválidos");
    res.json(await runStore.readOutput(run.id, index, query.data.afterSeq));
  });

  router.post("/runs/:id/reply", async (req, res) => {
    const parsed = ReplyRequestSchema.safeParse(req.body);
    if (!parsed.success) throw fromZodError(parsed.error, "Resposta inválida");
    await executor.reply(req.params.id, parsed.data.text);
    res.status(202).end();
  });

  router.post("/runs/:id/advance", async (req, res) => {
    await executor.advance(req.params.id);
    res.status(202).end();
  });

  // Interromper (FR-018): 202; 409 INVALID_STATE se não estiver em running/awaiting_input; 404 se não existir.
  router.post("/runs/:id/interrupt", async (req, res) => {
    await executor.interrupt(req.params.id);
    res.status(202).end();
  });

  return router;
}
