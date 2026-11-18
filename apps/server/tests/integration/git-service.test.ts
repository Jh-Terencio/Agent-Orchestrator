import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../../src/git/git-service.js";
import { createRemoteFor, createTempRepo, gitIn, type TempRepo } from "../fakes/temp-repo.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

let repo: TempRepo;
const extra: TempRepo[] = [];

beforeEach(async () => {
  repo = await createTempRepo();
});

afterEach(async () => {
  await repo.cleanup();
  for (const other of extra.splice(0)) await other.cleanup();
});

describe("GitService.inspect", () => {
  it("pasta inexistente → path_not_found", async () => {
    const info = await GitService.inspect(join(repo.path, "nao-existe"));
    expect(info).toMatchObject({ valid: false, currentBranch: null, problems: ["path_not_found"] });
  });

  it("pasta sem git → not_a_repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orchestrator-plain-"));
    // Impede o git de subir até um repositório que contenha a pasta temporária (ex.: o home do usuário).
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    try {
      const info = await GitService.inspect(dir);
      expect(info).toMatchObject({ valid: false, currentBranch: null, problems: ["not_a_repo"] });
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("arquivo modificado → dirty_worktree", async () => {
    await repo.writeFile("README.md", "alterado\n");
    const info = await GitService.inspect(repo.path);
    expect(info.valid).toBe(false);
    expect(info.problems).toEqual(["dirty_worktree"]);
  });

  it("arquivo não rastreado → dirty_worktree", async () => {
    await repo.writeFile("novo/arquivo.txt", "x\n");
    expect((await GitService.inspect(repo.path)).problems).toEqual(["dirty_worktree"]);
  });

  it("MERGE_HEAD presente → merge_or_rebase_in_progress", async () => {
    const head = await repo.git("rev-parse", "HEAD");
    await writeFile(join(repo.path, ".git", "MERGE_HEAD"), `${head}\n`);
    const info = await GitService.inspect(repo.path);
    expect(info.valid).toBe(false);
    expect(info.problems).toContain("merge_or_rebase_in_progress");
  });

  it("HEAD destacado → detached_head", async () => {
    await repo.git("switch", "--detach", "HEAD");
    const info = await GitService.inspect(repo.path);
    expect(info).toMatchObject({ valid: false, currentBranch: null });
    expect(info.problems).toEqual(["detached_head"]);
  });

  it("repo limpo → valid com currentBranch main e path do toplevel", async () => {
    const info = await GitService.inspect(repo.path);
    expect(info).toEqual({
      path: await repo.git("rev-parse", "--show-toplevel"),
      valid: true,
      currentBranch: "main",
      problems: [],
    });
  });

  it("subpasta do repo resolve para o toplevel", async () => {
    await repo.writeFile("sub/x.txt", "x\n");
    await repo.git("add", "-A");
    await repo.git("commit", "-m", "sub");
    const info = await GitService.inspect(join(repo.path, "sub"));
    expect(info.path).toBe(await repo.git("rev-parse", "--show-toplevel"));
    expect(info.valid).toBe(true);
  });
});

describe("GitService operações", () => {
  it("currentBranch retorna a branch ativa", async () => {
    expect(await new GitService(repo.path).currentBranch()).toBe("main");
  });

  it("snapshotRefs lista heads, remotes e tags com SHA", async () => {
    extra.push(await createRemoteFor(repo));
    await repo.git("tag", "v1");
    const head = await repo.git("rev-parse", "HEAD");
    const snapshot = await new GitService(repo.path).snapshotRefs();
    const refs = snapshot.map((entry) => entry.ref);
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("refs/remotes/origin/main");
    expect(refs).toContain("refs/tags/v1");
    expect(snapshot.find((entry) => entry.ref === "refs/heads/main")?.sha).toBe(head);
    for (const entry of snapshot) expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("createRunBranch cria e troca para orchestrator/<data>-<slug> e falha se já existir", async () => {
    const git = new GitService(repo.path);
    const date = new Date(2026, 10, 17, 12, 0, 0);
    const name = await git.createRunBranch("Adicionar login", date);
    expect(name).toBe("orchestrator/20261117-120000-adicionar-login");
    expect(await git.currentBranch()).toBe(name);
    await repo.git("switch", "main");
    await expect(git.createRunBranch("Adicionar login", date)).rejects.toThrow(/já existe|already exists/i);
  });

  it("hasChanges detecta alterações", async () => {
    const git = new GitService(repo.path);
    expect(await git.hasChanges()).toBe(false);
    await repo.writeFile("a.txt", "a\n");
    expect(await git.hasChanges()).toBe(true);
  });

  it("commitAll cria commit com trailer Orchestrator-Run e retorna null sem alterações", async () => {
    const git = new GitService(repo.path);
    expect(await git.commitAll("orchestrator: Specify concluído", RUN_ID)).toBeNull();

    await repo.writeFile("spec.md", "# spec\n");
    const sha = await git.commitAll("orchestrator: Specify concluído", RUN_ID);
    expect(sha).toBe(await repo.git("rev-parse", "HEAD"));
    const message = await repo.git("log", "-1", "--format=%B");
    expect(message).toContain("orchestrator: Specify concluído");
    expect((await repo.git("log", "-1", "--format=%(trailers:key=Orchestrator-Run,valueonly)")).trim()).toBe(RUN_ID);
    expect(await git.hasChanges()).toBe(false);
  });
});

describe("GitService.verifyAfterStep", () => {
  async function prepared(): Promise<{ git: GitService; snapshot: Awaited<ReturnType<GitService["snapshotRefs"]>> }> {
    extra.push(await createRemoteFor(repo));
    await repo.git("tag", "v1");
    await repo.git("branch", "feature");
    const git = new GitService(repo.path);
    const snapshot = await git.snapshotRefs();
    await git.createRunBranch("teste", new Date(2026, 10, 17, 12, 0, 0));
    return { git, snapshot };
  }

  it("sem mudanças → sem violações, branch ativa e nenhuma branch nova além da da execução", async () => {
    const { git, snapshot } = await prepared();
    const result = await git.verifyAfterStep(snapshot);
    expect(result.violations).toEqual([]);
    expect(result.activeBranch).toBe("orchestrator/20261117-120000-teste");
    expect(result.newBranches).toEqual(["orchestrator/20261117-120000-teste"]);
  });

  it("branch ativa pré-existente → violação", async () => {
    const { git, snapshot } = await prepared();
    await repo.git("switch", "main");
    const result = await git.verifyAfterStep(snapshot);
    expect(result.activeBranch).toBe("main");
    expect(result.violations.join("\n")).toContain("refs/heads/main");
  });

  it("branch pré-existente com SHA alterado → violação", async () => {
    const { git, snapshot } = await prepared();
    await repo.writeFile("x.txt", "x\n");
    await repo.git("add", "-A");
    await repo.git("commit", "-m", "x");
    await repo.git("branch", "-f", "feature", "HEAD");
    const result = await git.verifyAfterStep(snapshot);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("refs/heads/feature");
  });

  it("branch pré-existente removida → violação", async () => {
    const { git, snapshot } = await prepared();
    await repo.git("branch", "-D", "feature");
    const result = await git.verifyAfterStep(snapshot);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("refs/heads/feature");
  });

  it("tag criada → violação", async () => {
    const { git, snapshot } = await prepared();
    await repo.git("tag", "v2");
    const result = await git.verifyAfterStep(snapshot);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("refs/tags/v2");
  });

  it("tag removida → violação", async () => {
    const { git, snapshot } = await prepared();
    await repo.git("tag", "-d", "v1");
    const result = await git.verifyAfterStep(snapshot);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("refs/tags/v1");
  });

  it("ref remota alterada → violação", async () => {
    const { git, snapshot } = await prepared();
    const remote = extra[0];
    if (!remote) throw new Error("remote ausente");
    await remote.writeFile("more.md", "more\n");
    await remote.git("add", "-A");
    await remote.git("commit", "-m", "more");
    await gitIn(repo.path, "fetch", "origin");
    const result = await git.verifyAfterStep(snapshot);
    // O fetch também pode atualizar o symref refs/remotes/origin/HEAD, conforme a versão do git.
    expect(result.violations.some((message) => message.includes("refs/remotes/origin/main"))).toBe(true);
    for (const message of result.violations) expect(message).toContain("refs/remotes/origin/");
  });

  it("branch nova criada pelo passo não é violação e aparece em newBranches", async () => {
    const { git, snapshot } = await prepared();
    await repo.git("switch", "-c", "agente/extra");
    const result = await git.verifyAfterStep(snapshot);
    expect(result.violations).toEqual([]);
    expect(result.activeBranch).toBe("agente/extra");
    expect(result.newBranches.sort()).toEqual(["agente/extra", "orchestrator/20261117-120000-teste"]);
  });
});
