import express, { type Express } from "express";
import type { PermissionBroker } from "../execution/permission-broker.js";
import type { PipelineExecutor } from "../execution/pipeline-executor.js";
import type { PipelineStore } from "../storage/pipeline-store.js";
import type { RunStore } from "../storage/run-store.js";
import type { SettingsStore } from "../storage/settings-store.js";
import { errorMiddleware, notFoundHandler } from "./errors.js";
import { originGuard, type OriginGuardOptions } from "./origin-guard.js";
import { internalRouter } from "./routes/internal.js";
import { pipelinesRouter } from "./routes/pipelines.js";
import { reposRouter } from "./routes/repos.js";
import { runsRouter } from "./routes/runs.js";
import { settingsRouter } from "./routes/settings.js";

export interface AppDeps extends OriginGuardOptions {
  pipelineStore: PipelineStore;
  runStore: RunStore;
  settingsStore: SettingsStore;
  executor: PipelineExecutor;
  permissionBroker: PermissionBroker;
}

/** Express com origin guard, rotas sob `/api`, rota interna de permissões e serialização de erros (research R7). */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(originGuard(deps));
  app.use(express.json({ limit: "1mb" }));

  const api = express.Router();
  api.use(reposRouter());
  api.use(settingsRouter(deps.settingsStore));
  api.use(pipelinesRouter(deps.pipelineStore));
  api.use(runsRouter(deps.executor, deps.pipelineStore, deps.runStore));
  api.use(notFoundHandler);

  app.use("/api", api);
  // Fora de /api, depois do origin guard: só o relay de permissões chama (research R13).
  app.use(internalRouter(deps.permissionBroker));
  app.use(errorMiddleware);
  return app;
}
