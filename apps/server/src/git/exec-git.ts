import { execFile } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export const GIT_NOT_FOUND_MESSAGE =
  "Git não encontrado no PATH. Instale o Git (https://git-scm.com) e reinicie o orquestrador.";

/** Erro de ambiente (git ausente, cwd inexistente): não é um código de saída do git. */
export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUnavailableError";
  }
}

/**
 * Executa `git <args>` em `cwd` sem shell (research R6). Nunca rejeita por código de saída ≠ 0:
 * o chamador inspeciona `code`. Rejeita com `GitUnavailableError` se o binário não existir.
 */
export function execGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") {
          if (error.code === "ENOENT") {
            reject(new GitUnavailableError(GIT_NOT_FOUND_MESSAGE));
            return;
          }
          reject(error);
          return;
        }
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** Como `execGit`, mas lança com o stderr do git quando o código de saída ≠ 0. */
export async function execGitOrThrow(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execGit(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `código ${result.code}`;
    throw new Error(`git ${args[0] ?? ""} falhou: ${detail}`);
  }
  return result.stdout;
}
