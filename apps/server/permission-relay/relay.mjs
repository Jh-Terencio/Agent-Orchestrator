// Servidor MCP stdio mínimo que repassa os pedidos de permissão da CLI ao orquestrador (research R13).
//
// A CLI o inicia por `--mcp-config` e o consulta pela ferramenta `approve`
// (`--permission-prompt-tool mcp__orchestrator__approve`) antes de cada uso de ferramenta não aprovado.
// O relay não decide nada: faz POST do pedido em ORCHESTRATOR_PERMISSION_URL, com o token da invocação
// em X-Orchestrator-Token, e devolve a decisão. Qualquer falha nega (FR-031).
//
// JavaScript puro, sem dependências: roda com `node` em desenvolvimento e em produção. HTTP com
// `node:http` e sem timeout, porque o `fetch` do Node corta respostas que demoram mais de 300 s.

import { request } from "node:http";
import { createInterface } from "node:readline";

const URL_ENV = process.env.ORCHESTRATOR_PERMISSION_URL ?? "";
const TOKEN = process.env.ORCHESTRATOR_PERMISSION_TOKEN ?? "";
const FAIL_MESSAGE = "O orquestrador não respondeu ao pedido de permissão; comando negado.";

const APPROVE_TOOL = {
  name: "approve",
  description: "Pede ao usuário do orquestrador permissão para usar uma ferramenta.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const deny = (message) => ({ behavior: "deny", message });

function isDecision(value) {
  if (typeof value !== "object" || value === null) return false;
  if (value.behavior === "allow") return typeof value.updatedInput === "object" && value.updatedInput !== null;
  if (value.behavior === "deny") return typeof value.message === "string";
  return false;
}

/** POST ao orquestrador; resolve sempre com uma decisão (nunca rejeita). */
function askOrchestrator(body) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(URL_ENV);
    } catch {
      resolve(deny(FAIL_MESSAGE));
      return;
    }
    const payload = JSON.stringify(body);
    const req = request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-orchestrator-token": TOKEN,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("error", () => resolve(deny(FAIL_MESSAGE)));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(deny(FAIL_MESSAGE));
          try {
            const decision = JSON.parse(raw);
            resolve(isDecision(decision) ? decision : deny(FAIL_MESSAGE));
          } catch {
            resolve(deny(FAIL_MESSAGE));
          }
        });
      },
    );
    req.on("error", () => resolve(deny(FAIL_MESSAGE)));
    req.end(payload);
  });
}

async function handleCall(message) {
  const args = message.params?.arguments ?? {};
  const input = typeof args.input === "object" && args.input !== null ? args.input : {};
  const decision = await askOrchestrator({
    toolName: typeof args.tool_name === "string" ? args.tool_name : "",
    input,
    toolUseId: typeof args.tool_use_id === "string" ? args.tool_use_id : "",
  });
  send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
}

function handle(message) {
  const hasId = message.id !== undefined && message.id !== null;
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "orchestrator", version: "1.0.0" },
        },
      });
      return;
    case "tools/list":
      send({ id: message.id, result: { tools: [APPROVE_TOOL] } });
      return;
    case "tools/call":
      void handleCall(message);
      return;
    default:
      // Notificações não têm resposta; qualquer outro pedido recebe um resultado vazio.
      if (hasId) send({ id: message.id, result: {} });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message === "object" && message !== null) handle(message);
});

// A CLI fecha o stdin ao terminar: encerra mesmo com um pedido HTTP pendente.
process.stdin.on("end", () => process.exit(0));
