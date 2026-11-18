import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { AgentRunner } from "./agent/agent-runner.js";
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
  /** Runner do agente; o executor que o usa entra nas próximas fases. */
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
  agentRunner: AgentRunner | undefined;
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

  let port = options.port ?? envPort();
  const guard = { getPort: () => port, devPorts: options.devPorts ?? envDevPorts() };

  const app = createApp({ ...guard, pipelineStore, runStore, settingsStore });
  const server = createServer(app);
  const hub = new EventHub(server, {
    isAllowed: (req) => isAllowedRequest(req, guard),
    getActiveRun: () => null,
  });

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
    agentRunner: options.agentRunner,
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
    running.close().then(
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
