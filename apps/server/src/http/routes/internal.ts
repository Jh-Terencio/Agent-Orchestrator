import { Router } from "express";
import { z } from "zod";
import {
  INTERNAL_PERMISSION_PATH,
  UNKNOWN_TOKEN_MESSAGE,
  type PermissionBroker,
} from "../../execution/permission-broker.js";

const PermissionCallSchema = z.object({
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  toolUseId: z.string(),
});

/**
 * Rotas internas, chamadas só pelo relay de permissões (research R13). Ficam fora de `/api`, sob o
 * origin guard e o `listen` em 127.0.0.1. Toda resposta é uma decisão: em erro, `deny`.
 */
export function internalRouter(broker: PermissionBroker): Router {
  const router = Router();

  router.post(INTERNAL_PERMISSION_PATH, async (req, res) => {
    const token = req.get("x-orchestrator-token");
    if (!token || !broker.hasChannel(token)) {
      res.status(403).json({ behavior: "deny", message: UNKNOWN_TOKEN_MESSAGE });
      return;
    }
    const parsed = PermissionCallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ behavior: "deny", message: "Pedido de permissão inválido; comando negado." });
      return;
    }
    // A resposta fica pendente até a decisão do usuário (ou de uma regra de "permitir sempre").
    res.status(200).json(await broker.request(token, parsed.data));
  });

  return router;
}
