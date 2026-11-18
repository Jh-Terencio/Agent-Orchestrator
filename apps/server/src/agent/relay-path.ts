import { fileURLToPath } from "node:url";

export interface RelayCommand {
  command: string;
  args: string[];
}

/**
 * Comando que inicia o relay de permissões (research R13): o `node` atual com
 * `apps/server/permission-relay/relay.mjs`. O caminho relativo vale para `src/agent` (tsx) e
 * `dist/agent` (build), que ficam no mesmo nível sob `apps/server`.
 */
export function relayCommand(): RelayCommand {
  const script = fileURLToPath(new URL("../../permission-relay/relay.mjs", import.meta.url));
  return { command: process.execPath, args: [script] };
}
