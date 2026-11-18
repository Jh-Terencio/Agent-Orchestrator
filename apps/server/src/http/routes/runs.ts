import { Router } from "express";
import { ReplyRequestSchema, StartRunRequestSchema } from "@orchestrator/shared";
import type { PipelineExecutor } from "../../execution/pipeline-executor.js";
import type { PipelineStore } from "../../storage/pipeline-store.js";
import { fromZodError } from "../errors.js";

/** Execuções (contracts/rest-api.md, "Execuções"). */
export function runsRouter(executor: PipelineExecutor, pipelineStore: PipelineStore): Router {
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

  return router;
}
