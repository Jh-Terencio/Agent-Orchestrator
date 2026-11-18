import type { AgentInvocation } from "./agent-runner.js";
import { NON_INTERACTIVE_SYSTEM_PROMPT } from "./system-prompts.js";

/** Ferramentas pré-aprovadas em `-p` (research R3). As demais são negadas automaticamente. */
export const ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Skill",
  "TodoWrite",
  "Bash",
  "PowerShell",
];

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

/** Cada comando proibido nas formas `Bash(...)` e `PowerShell(...)` (research R2/R3). */
export const DISALLOWED_TOOLS: readonly string[] = [
  ...FORBIDDEN_GIT_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
  ...FORBIDDEN_GIT_COMMANDS.map((cmd) => `PowerShell(${cmd}:*)`),
];

/** Isola a configuração pessoal do usuário (plugins, hooks, skills e MCP de `~/.claude`; research R3a). */
export const ISOLATION_ARGS: readonly string[] = ["--setting-sources", "project,local", "--strict-mcp-config"];

/** Argumentos da CLI (sem o executável) conforme contracts/agent-runner.md. */
export function buildClaudeArgs(
  invocation: Pick<AgentInvocation, "prompt" | "model" | "sessionId" | "resume" | "interactive">,
): string[] {
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
    "acceptEdits",
    ...ISOLATION_ARGS,
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];
  if (!invocation.interactive) args.push("--append-system-prompt", NON_INTERACTIVE_SYSTEM_PROMPT);
  return args;
}
