import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

export const CLAUDE_NOT_FOUND_MESSAGE =
  "Claude Code não encontrado no PATH. Instale e rode `claude` uma vez para fazer login.";
export const CLAUDE_CLI_JS_NOT_FOUND_MESSAGE =
  "Encontrei claude.cmd, mas não consegui localizar o cli.js do Claude Code. Reinstale com o instalador nativo (claude.exe).";

export interface ResolveClaudeDeps {
  platform: NodeJS.Platform;
  /** Conteúdo de `PATH`. */
  pathEnv: string;
  /** Conteúdo de `PATHEXT` (informativo: só `.exe` e `.cmd` são procurados). */
  pathExt?: string;
  /** Executável do Node usado para rodar o `cli.js` (padrão: `process.execPath`). */
  execPath: string;
  exists: (path: string) => boolean;
  /** Conteúdo do arquivo, ou `null` se não puder ser lido. */
  readFile: (path: string) => string | null;
}

export type ResolvedClaude = { command: string; prefixArgs: string[] } | { error: string };

/** Caminho do `cli.js` referenciado num shim `.cmd` do npm (`"%dp0%\node_modules\...\cli.js"`). */
function cliJsFromShim(shimPath: string, content: string | null): string {
  const dir = win32.dirname(shimPath);
  const match = content?.match(/%~?dp0%?\\?([^"%\r\n]*?cli\.js)/i);
  if (match?.[1]) return win32.join(dir, match[1]);
  return win32.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
}

/**
 * Resolve o executável do Claude Code sem shell (contracts/agent-runner.md, "Resolução do executável").
 * Função pura: todo I/O é injetado. Nunca devolve `.cmd`/`.bat`, que o Node não executa sem shell.
 */
export function resolveClaudeCommand(deps: ResolveClaudeDeps): ResolvedClaude {
  if (deps.platform !== "win32") return { command: "claude", prefixArgs: [] };

  const dirs = deps.pathEnv
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir.length > 0);

  for (const dir of dirs) {
    const exe = win32.join(dir, "claude.exe");
    if (deps.exists(exe)) return { command: exe, prefixArgs: [] };
  }

  for (const dir of dirs) {
    const shim = win32.join(dir, "claude.cmd");
    if (!deps.exists(shim)) continue;
    const cliJs = cliJsFromShim(shim, deps.readFile(shim));
    if (deps.exists(cliJs)) return { command: deps.execPath, prefixArgs: [cliJs] };
    return { error: CLAUDE_CLI_JS_NOT_FOUND_MESSAGE };
  }

  return { error: CLAUDE_NOT_FOUND_MESSAGE };
}

/** Dependências reais do processo atual. */
export function systemResolveDeps(): ResolveClaudeDeps {
  return {
    platform: process.platform,
    pathEnv: process.env.PATH ?? process.env.Path ?? "",
    ...(process.env.PATHEXT === undefined ? {} : { pathExt: process.env.PATHEXT }),
    execPath: process.execPath,
    exists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}
