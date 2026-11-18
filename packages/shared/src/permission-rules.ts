/**
 * Regras de "permitir sempre nesta execução" (FR-029, research R13). Puro, sem I/O: usado pelo
 * executor para casar pedidos e pela interface para mostrar a regra antes do clique.
 */

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** Uma regra nunca casa com comandos encadeados ou com substituição de comando. */
const SHELL_SEPARATORS = [";", "&&", "||", "|", "`", "$(", "\n", "\r"];
const SUMMARY_MAX = 200;

function shellCommand(input: Record<string, unknown>): string | null {
  const command = input.command;
  return typeof command === "string" && command.trim().length > 0 ? command.trim() : null;
}

/**
 * Regra derivada de um pedido: para `Bash`/`PowerShell`, os dois primeiros tokens do comando no
 * formato do Claude Code (`Bash(npm test:*)`), ou só um se houver um; para as demais, o nome.
 */
export function deriveRule(toolName: string, input: Record<string, unknown>): string {
  const command = SHELL_TOOLS.has(toolName) ? shellCommand(input) : null;
  if (command === null) return toolName;
  const prefix = command.split(/\s+/).slice(0, 2).join(" ");
  return `${toolName}(${prefix}:*)`;
}

/** `true` se a regra libera este uso de ferramenta sem perguntar. */
export function matchesRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const match = /^([A-Za-z0-9_]+)\((.+):\*\)$/s.exec(rule);
  if (match === null) return rule === toolName;
  const [, ruleTool, prefix] = match;
  if (ruleTool !== toolName || prefix === undefined) return false;
  const command = shellCommand(input);
  if (command === null) return false;
  if (SHELL_SEPARATORS.some((separator) => command.includes(separator))) return false;
  return command === prefix || command.startsWith(`${prefix} `);
}

/** Resumo de uma chamada de ferramenta: o campo mais informativo da entrada, numa linha. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "skill", "url", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return truncate(value);
  }
  return truncate(JSON.stringify(input));
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine;
}
