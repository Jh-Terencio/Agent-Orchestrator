import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Roda `git` no diretório indicado e devolve o stdout sem a quebra de linha final. */
export async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.replace(/\r?\n$/, "");
}

export interface TempRepo {
  /** Caminho do repositório (como criado por `mkdtemp`). */
  path: string;
  git(...args: string[]): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function initRepo(prefix: string): Promise<TempRepo> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const repo: TempRepo = {
    path,
    git: (...args) => gitIn(path, ...args),
    async writeFile(relativePath, content) {
      const target = join(path, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await fsWriteFile(target, content, "utf8");
    },
    cleanup: () => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
  await repo.git("init", "-b", "main");
  await repo.git("config", "user.name", "Orchestrator Test");
  await repo.git("config", "user.email", "test@example.invalid");
  await repo.git("config", "commit.gpgsign", "false");
  await repo.git("config", "core.autocrlf", "false");
  return repo;
}

/** Repositório temporário com `main` e um commit inicial. */
export async function createTempRepo(): Promise<TempRepo> {
  const repo = await initRepo("orchestrator-repo-");
  await repo.writeFile("README.md", "# temp\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-m", "initial");
  return repo;
}

/**
 * Cria um segundo repositório temporário, o registra como `origin` de `repo` e faz `git fetch`,
 * criando `refs/remotes/origin/main`. Devolve o repositório remoto (para alterá-lo nos testes).
 */
export async function createRemoteFor(repo: TempRepo): Promise<TempRepo> {
  const remote = await createTempRepo();
  await remote.writeFile("REMOTE.md", "remote\n");
  await remote.git("add", "-A");
  await remote.git("commit", "-m", "remote commit");
  await repo.git("remote", "add", "origin", remote.path);
  await repo.git("fetch", "origin");
  return remote;
}
