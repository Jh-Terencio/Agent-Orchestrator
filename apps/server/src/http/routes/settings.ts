import { Router } from "express";
import type { SettingsStore } from "../../storage/settings-store.js";

/** `GET /settings` → `Settings`. */
export function settingsRouter(settingsStore: SettingsStore): Router {
  const router = Router();
  router.get("/settings", async (_req, res) => {
    res.json(await settingsStore.get());
  });
  return router;
}
