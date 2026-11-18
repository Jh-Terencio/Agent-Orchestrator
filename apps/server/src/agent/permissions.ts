import type { AgentInvocation } from "./agent-runner.js";
import { relayCommand, type RelayCommand } from "./relay-path.js";
import { NON_INTERACTIVE_SYSTEM_PROMPT } from "./system-prompts.js";

/** Ferramentas pré-aprovadas fora do shell (research R3). Valem nos dois modos. */
const BASE_ALLOWED_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Glob", "Grep", "Skill", "TodoWrite"];

/** Ferramentas pré-aprovadas no Modo Yolo (research R3): inclui o shell. */
export const ALLOWED_TOOLS: readonly string[] = [...BASE_ALLOWED_TOOLS, "Bash", "PowerShell"];

/**
 * Ferramentas pré-aprovadas com o Modo Yolo desligado (research R13): sem `Bash`/`PowerShell`, que
 * passam a gerar pedidos de permissão (exceto os comandos que a própria CLI considera somente leitura).
 */
export const PROMPTED_ALLOWED_TOOLS: readonly string[] = BASE_ALLOWED_TOOLS;

/** Comandos git que movem refs ou publicam: commits e branches são do orquestrador (FR-010/FR-011a). */
export const FORBIDDEN_GIT_COMMANDS: readonly string[] = [
  "git push",
  "git merge",
  "git rebase",
  "git reset",
  "git commit",
  "git cherry-pick",
  "git revert",
  "git tag",
  "git branch -D",
  "git branch -d",
  "git update-ref",
];

/** Cada comando proibido nas formas `Bash(...)` e `PowerShell(...)` (research R2/R3). Vale nos dois modos. */
export const DISALLOWED_TOOLS: readonly string[] = [
  ...FORBIDDEN_GIT_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
  ...FORBIDDEN_GIT_COMMANDS.map((cmd) => `PowerShell(${cmd}:*)`),
];

/** Isola a configuração pessoal do usuário (plugins, hooks, skills e MCP de `~/.claude`; research R3a). */
export const ISOLATION_ARGS: readonly string[] = ["--setting-sources", "project,local", "--strict-mcp-config"];

/** Ferramenta MCP consultada pela CLI antes de cada uso não aprovado (servidor `orchestrator`, ferramenta `approve`). */
export const PERMISSION_TOOL = "mcp__orchestrator__approve";

/**
 * `--permission-mode` do Modo Yolo. Verificado na CLI 2.1.327 (T105, research R13):
 * `bypassPermissions` continua respeitando `--disallowedTools` (o `git tag` foi bloqueado) e libera
 * também ferramentas fora da lista, como `WebFetch`.
 */
export const YOLO_PERMISSION_MODE = "bypassPermissions";

/**
 * Variáveis de ambiente extras do `spawn` com o Modo Yolo desligado. Vazio: a CLI 2.1.327 esperou
 * 6 min pela resposta do relay sem desistir e sem nenhum ajuste (T105, research R13).
 */
export const PERMISSION_ENV: Readonly<Record<string, string>> = {};

type ArgsInvocation = Pick<
  AgentInvocation,
  "prompt" | "model" | "sessionId" | "resume" | "interactive" | "permissionChannel"
>;

/** Argumentos da CLI (sem o executável) conforme contracts/agent-runner.md. */
export function buildClaudeArgs(invocation: ArgsInvocation, relay?: RelayCommand): string[] {
  const channel = invocation.permissionChannel;
  const args = [
    "-p",
    invocation.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    invocation.model,
    invocation.resume ? "--resume" : "--session-id",
    invocation.sessionId,
    "--permission-mode",
    channel === null ? YOLO_PERMISSION_MODE : "acceptEdits",
    ...ISOLATION_ARGS,
    "--allowedTools",
    ...(channel === null ? ALLOWED_TOOLS : PROMPTED_ALLOWED_TOOLS),
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];
  if (channel !== null) {
    const { command, args: relayArgs } = relay ?? relayCommand();
    const config = {
      mcpServers: {
        orchestrator: {
          command,
          args: relayArgs,
          env: { ORCHESTRATOR_PERMISSION_URL: channel.url, ORCHESTRATOR_PERMISSION_TOKEN: channel.token },
        },
      },
    };
    args.push("--mcp-config", JSON.stringify(config), "--permission-prompt-tool", PERMISSION_TOOL);
  }
  if (!invocation.interactive) args.push("--append-system-prompt", NON_INTERACTIVE_SYSTEM_PROMPT);
  return args;
}
