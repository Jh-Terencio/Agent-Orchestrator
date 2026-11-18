import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandExists } from "../../src/agent/command-lookup.js";

let repo: string;
let home: string;

async function touch(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "# comando\n", "utf8");
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "orchestrator-lookup-repo-"));
  home = await mkdtemp(join(tmpdir(), "orchestrator-lookup-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("commandExists", () => {
  it("true com .claude/skills/<nome>/SKILL.md no repositório", async () => {
    await touch(join(repo, ".claude", "skills", "speckit-plan", "SKILL.md"));
    expect(await commandExists(repo, "/speckit-plan")).toBe(true);
  });

  it("true com .claude/commands/<nome>.md no repositório", async () => {
    await touch(join(repo, ".claude", "commands", "speckit-plan.md"));
    expect(await commandExists(repo, "/speckit-plan")).toBe(true);
  });

  it("considera só o primeiro token do prompt", async () => {
    await touch(join(repo, ".claude", "skills", "speckit-specify", "SKILL.md"));
    expect(await commandExists(repo, "/speckit-specify Adicionar login com e-mail")).toBe(true);
  });

  it("aceita a forma com ponto (Spec Kit antigo)", async () => {
    await touch(join(repo, ".claude", "commands", "speckit.plan.md"));
    expect(await commandExists(repo, "/speckit.plan")).toBe(true);
  });

  it("false quando não existe no repositório", async () => {
    expect(await commandExists(repo, "/speckit-plan")).toBe(false);
  });

  it("false quando só existe em ~/.claude (skills pessoais não carregam com --setting-sources project,local)", async () => {
    await touch(join(home, ".claude", "skills", "speckit-plan", "SKILL.md"));
    await touch(join(home, ".claude", "commands", "speckit-plan.md"));
    expect(await commandExists(repo, "/speckit-plan")).toBe(false);
  });

  it("prompt que não começa com / retorna true sem verificar", async () => {
    expect(await commandExists(repo, "Explique o projeto")).toBe(true);
    expect(await commandExists(join(repo, "nao-existe"), "qualquer coisa")).toBe(true);
  });

  it("nome com separador de caminho é recusado", async () => {
    await touch(join(repo, ".claude", "commands", "x.md"));
    expect(await commandExists(repo, "/../commands/x")).toBe(false);
    expect(await commandExists(repo, "/")).toBe(false);
  });
});
