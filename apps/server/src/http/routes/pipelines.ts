import { Router } from "express";
import type { PipelineStore } from "../../storage/pipeline-store.js";

/** `GET /pipelines` (padrão primeiro, depois por nome). O CRUD completo chega em US4. */
export function pipelinesRouter(pipelineStore: PipelineStore): Router {
  const router = Router();
  router.get("/pipelines", async (_req, res) => {
    res.json(await pipelineStore.list());
  });
  return router;
}
