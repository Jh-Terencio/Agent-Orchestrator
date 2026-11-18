import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { AgentRunner } from "./agent/agent-runner.js";
import { ClaudeCliRunner } from "./agent/claude-cli-runner.js";
import { PipelineExecutor } from "./execution/pipeline-executor.js";
import { recoverInterruptedRuns } from "./execution/recovery.js";
import { RunLock } from "./execution/run-lock.js";
import { createApp } from "./http/app.js";
import { isAllowedRequest } from "./http/origin-guard.js";
import { ensureDataDirs, resolveDataDir } from "./storage/data-dir.js";
import { PipelineStore } from "./storage/pipeline-store.js";
import { RunStore } from "./storage/run-store.js";
import { SettingsStore } from "./storage/settings-store.js";
import { EventHub } from "./ws/event-hub.js";

export const DEFAULT_PORT = 4317;
export const HOST = "127.0.0.1";
/** Porta do Vite em desenvolvimento, aceita pelo origin guard. */
export const DEFAULT_DEV_PORTS: readonly number[] = [5173];

export interface StartServerOptions {
  /** 0 = porta efêmera (testes). Padrão: `ORCHESTRATOR_PORT` ou 4317. */
  port?: number;
  /** Padrão: `resolveDataDir()`. */
  dataDir?: string;
  /** Runner do agente. Padrão: `ClaudeCliRunner` (a CLI `claude` real); os testes passam o fake. */
  agentRunner?: AgentRunner;
  devPorts?: readonly number[];
}

export interface RunningServer {
  server: Server;
  port: number;
  hub: EventHub;
  pipelineStore: PipelineStore;
  runStore: RunStore;
  settingsStore: SettingsStore;
  agentRunner: AgentRunner;
  executor: PipelineExecutor;
  close(): Promise<void>;
}

function envPort(): number {
  const raw = process.env.ORCHESTRATOR_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ORCHESTRATOR_PORT inválida: "${raw}". Use um número entre 1 e 65535.`);
  }
  return port;
}

function envDevPorts(): readonly number[] {
  const raw = process.env.ORCHESTRATOR_DEV_PORTS;
  if (raw === undefined) return DEFAULT_DEV_PORTS;
  return raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);
}

/** Composição do servidor: data dir, stores, Express, WebSocket e `listen` em 127.0.0.1 (FR-026). */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const dataDir = options.dataDir ?? resolveDataDir();
  await ensureDataDirs(dataDir);

  const pipelineStore = new PipelineStore(dataDir);
  const runStore = new RunStore(dataDir);
  const settingsStore = new SettingsStore(dataDir);
  await pipelineStore.init();
  // Runs que ficaram em andamento quando o processo morreu viram `interrupted` antes do listen (R8).
  const recovered = await recoverInterruptedRuns(runStore);
  if (recovered.length > 0) {
    console.log(`Execuções interrompidas pelo encerramento anterior marcadas como interrompidas: ${recovered.join(", ")}`);
  }

  let port = options.port ?? envPort();
  const guard = { getPort: () => port, devPorts: options.devPorts ?? envDevPorts() };

  const agentRunner = options.agentRunner ?? new ClaudeCliRunner();
  // O hub depende do http.Server, que depende do app, que depende do executor: o executor
  // recebe um encaminhador, e o hub é ligado logo abaixo.
  let hubRef: EventHub | null = null;
  const executor = new PipelineExecutor({
    agentRunner,
    runStore,
    settingsStore,
    eventHub: {
      broadcast: (event) => hubRef?.broadcast(event),
      pushOutput: (runId, stepIndex, entry) => hubRef?.pushOutput(runId, stepIndex, entry),
    },
    lock: new RunLock(),
  });

  const app = createApp({ ...guard, pipelineStore, runStore, settingsStore, executor });
  const server = createServer(app);
  const hub = new EventHub(server, {
    isAllowed: (req) => isAllowedRequest(req, guard),
    getActiveRun: () => executor.getActiveRun(),
  });
  hubRef = hub;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    hub,
    pipelineStore,
    runStore,
    settingsStore,
    agentRunner,
    executor,
    async close() {
      await hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function main(): Promise<void> {
  const running = await startServer();
  console.log(`Orquestrador ouvindo em http://${HOST}:${running.port}`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} recebido; encerrando...`);
    // Primeiro interrompe o run ativo (commit WIP e run.json gravado); só então fecha WS e HTTP.
    running.executor
      .shutdown()
      .catch((error: unknown) => console.error("Falha ao interromper a execução ativa:", error))
      .then(() => running.close())
      .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Falha ao encerrar:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EADDRINUSE") {
      console.error(`A porta já está em uso. Feche a outra instância ou defina ORCHESTRATOR_PORT.`);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
