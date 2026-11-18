import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RefEntry, RepoInfo, RepoProblem } from "@orchestrator/shared";
import { buildRunBranchName } from "./branch-name.js";
import { execGit, execGitOrThrow } from "./exec-git.js";

const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge", "rebase-apply"];

export interface VerifyResult {
  /** Mensagens legíveis; cada uma cita o nome completo da ref afetada. Vazio = passou. */
  violations: string[];
  activeBranch: string;
  /** Branches locais que não estavam no snapshot (ex.: a da execução ou uma criada pelo agente). */
  newBranches: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Única porta de entrada para o `git` (research R6). Operações de instância rodam em `repoPath`. */
export class GitService {
  constructor(readonly repoPath: string) {}

  /** Validações de FR-002/FR-003a. Nunca lança por problema do repositório: os problemas vão em `problems`. */
  static async inspect(path: string): Promise<RepoInfo> {
    const invalid = (problem: RepoProblem): RepoInfo => ({
      path,
      valid: false,
      currentBranch: null,
      problems: [problem],
    });

    if (!(await pathExists(path))) return invalid("path_not_found");

    const inside = await execGit(path, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") return invalid("not_a_repo");

    const toplevel = (await execGitOrThrow(path, ["rev-parse", "--show-toplevel"])).trim();
    const git = new GitService(toplevel);
    const problems: RepoProblem[] = [];

    if (await git.hasChanges()) problems.push("dirty_worktree");
    if (await git.operationInProgress()) problems.push("merge_or_rebase_in_progress");
    const currentBranch = await git.currentBranch();
    if (currentBranch === null) problems.push("detached_head");

    return { path: toplevel, valid: problems.length === 0, currentBranch, problems };
  }

  /** Nome curto da branch ativa, ou `null` com HEAD destacado. */
  async currentBranch(): Promise<string | null> {
    const result = await execGit(this.repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const name = result.stdout.trim();
    return result.code === 0 && name ? name : null;
  }

  async hasChanges(): Promise<boolean> {
    const status = await execGitOrThrow(this.repoPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    return status.trim().length > 0;
  }

  /** `refs/heads`, `refs/remotes` e `refs/tags` com o SHA de cada uma (FR-011a). */
  async snapshotRefs(): Promise<RefEntry[]> {
    const out = await execGitOrThrow(this.repoPath, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const space = line.lastIndexOf(" ");
        return { ref: line.slice(0, space), sha: line.slice(space + 1) };
      });
  }

  /** Cria e troca para `orchestrator/<data>-<slug>` (FR-004). Falha se o nome já existir. */
  async createRunBranch(description: string, date: Date = new Date()): Promise<string> {
    const name = buildRunBranchName(description, date);
    const exists = await execGit(this.repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    if (exists.code === 0) throw new Error(`A branch ${name} já existe`);
    await execGitOrThrow(this.repoPath, ["switch", "-c", name]);
    return name;
  }

  /**
   * `git add -A` + `git commit` com o trailer `Orchestrator-Run: <runId>`.
   * Retorna o SHA do commit, ou `null` se não houver alterações (research R6).
   */
  async commitAll(message: string, runId: string): Promise<string | null> {
    if (!(await this.hasChanges())) return null;
    await execGitOrThrow(this.repoPath, ["add", "-A"]);
    await execGitOrThrow(this.repoPath, ["commit", "--no-verify", "-m", message, "-m", `Orchestrator-Run: ${runId}`]);
    return (await execGitOrThrow(this.repoPath, ["rev-parse", "HEAD"])).trim();
  }

  /** Compara as refs atuais com o snapshot pelas três regras de FR-011a. */
  async verifyAfterStep(snapshot: readonly RefEntry[]): Promise<VerifyResult> {
    const before = new Map(snapshot.map((entry) => [entry.ref, entry.sha]));
    const after = new Map((await this.snapshotRefs()).map((entry) => [entry.ref, entry.sha]));
    const activeBranch = (await this.currentBranch()) ?? "HEAD";
    const violations: string[] = [];

    // (a) a branch ativa não pode ser pré-existente
    const activeRef = `refs/heads/${activeBranch}`;
    if (activeBranch === "HEAD") {
      violations.push("O passo deixou o repositório com HEAD destacado (sem branch ativa)");
    } else if (before.has(activeRef)) {
      violations.push(`A branch ativa ${activeRef} é uma branch pré-existente`);
    }

    // (b) branches pré-existentes não podem mudar nem sumir; (c) remotas e tags não podem mudar em nada
    for (const [ref, sha] of before) {
      const current = after.get(ref);
      if (current === undefined) violations.push(`${describeRef(ref)} ${ref} foi removida`);
      else if (current !== sha) violations.push(`${describeRef(ref)} ${ref} foi alterada (${short(sha)} → ${short(current)})`);
    }

    const newBranches: string[] = [];
    for (const ref of after.keys()) {
      if (before.has(ref)) continue;
      if (ref.startsWith("refs/heads/")) newBranches.push(ref.slice("refs/heads/".length));
      else violations.push(`${describeRef(ref)} ${ref} foi criada`);
    }

    return { violations, activeBranch, newBranches };
  }

  private async operationInProgress(): Promise<boolean> {
    let gitDir = (await execGitOrThrow(this.repoPath, ["rev-parse", "--git-dir"])).trim();
    if (!isAbsolute(gitDir)) gitDir = join(this.repoPath, gitDir);
    for (const marker of IN_PROGRESS_MARKERS) {
      if (await pathExists(join(gitDir, marker))) return true;
    }
    return false;
  }
}

function describeRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return "A branch pré-existente";
  if (ref.startsWith("refs/tags/")) return "A tag";
  if (ref.startsWith("refs/remotes/")) return "A referência remota";
  return "A referência";
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
