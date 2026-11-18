import { Router } from "express";
import { z } from "zod";
import { GitService } from "../../git/git-service.js";
import { fromZodError } from "../errors.js";

const InspectQuerySchema = z.object({
  path: z.string().trim().min(1, "Informe o caminho do repositório"),
});

/** `GET /repos/inspect?path=` → `RepoInfo` (sempre 200; os problemas vão em `problems`). */
export function reposRouter(): Router {
  const router = Router();
  router.get("/repos/inspect", async (req, res) => {
    const parsed = InspectQuerySchema.safeParse(req.query);
    if (!parsed.success) throw fromZodError(parsed.error, "Parâmetro path inválido");
    res.json(await GitService.inspect(parsed.data.path));
  });
  return router;
}
