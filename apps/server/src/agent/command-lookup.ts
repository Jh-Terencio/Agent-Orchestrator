import { stat } from "node:fs/promises";
import { join } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Pré-verificação do comando do passo (research R2): só o repositório conta, porque com
 * `--setting-sources project,local` as skills e comandos de `~/.claude` não carregam (R3a).
 * Prompts que não começam com `/` não são verificados.
 */
export async function commandExists(repoPath: string, prompt: string): Promise<boolean> {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("/")) return true;
  const name = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
  if (!SAFE_NAME.test(name)) return false;
  const claudeDir = join(repoPath, ".claude");
  return (
    (await isFile(join(claudeDir, "skills", name, "SKILL.md"))) ||
    (await isFile(join(claudeDir, "commands", `${name}.md`)))
  );
}
