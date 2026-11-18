import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultPipeline,
  type OutputEntry,
  type Pipeline,
  type Run,
  type ServerEvent,
  type Usage,
} from "@orchestrator/shared";
import { buildRunBranchName } from "../../src/git/branch-name.js";
import { ApiError } from "../../src/http/errors.js";
import { PermissionBroker } from "../../src/execution/permission-broker.js";
import { PipelineExecutor } from "../../src/execution/pipeline-executor.js";
import { RunLock } from "../../src/execution/run-lock.js";
import { RunStore } from "../../src/storage/run-store.js";
import { SettingsStore } from "../../src/storage/settings-store.js";
import { FakeAgentRunner, type FakeScript } from "../fakes/fake-agent-runner.js";
import { createTempRepo, gitIn, type TempRepo } from "../fakes/temp-repo.js";

const NOW = "2026-11-17T12:00:00.000Z";
const DESCRIPTION = "Adicionar login com e-mail";

let repo: TempRepo;
let dataDir: string;
let runStore: RunStore;
let settingsStore: SettingsStore;
let events: ServerEvent[];
/** Entradas passadas a `eventHub.pushOutput`, em ordem. */
let pushed: Array<{ runId: string; stepIndex: number; entry: OutputEntry }>;
let lock: RunLock;
let runner: FakeAgentRunner;
let broker: PermissionBroker;
let executor: PipelineExecutor;
let fileCounter = 0;

/** Simula o agente escrevendo um arquivo novo no repositório. */
const writesFile: NonNullable<FakeScript["sideEffect"]> = async (cwd) => {
  fileCounter += 1;
  await writeFile(join(cwd, `artefato-${fileCounter}.md`), `conteúdo ${fileCounter}\n`, "utf8");
};

const usage = (costUsd: number | null, extra: Partial<Usage> = {}): Usage => ({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd,
  numTurns: 1,
  ...extra,
});

function makeExecutor(scripts: FakeScript[] = [], fallback: FakeScript = { sideEffect: writesFile }, clock?: () => Date) {
  broker = new PermissionBroker(() => "http://127.0.0.1:1");
  runner = new FakeAgentRunner(scripts, fallback, broker);
  executor = new PipelineExecutor({
    agentRunner: runner,
    permissionBroker: broker,
    runStore,
    settingsStore,
    eventHub: {
      broadcast: (event) => events.push(event),
      pushOutput: (runId, stepIndex, entry) => pushed.push({ runId, stepIndex, entry }),
    },
    lock,
    ...(clock ? { clock } : {}),
  });
  return executor;
}

/** Instala as skills dos comandos no repositório (commitadas, para a árvore continuar limpa). */
async function installCommands(target: TempRepo, pipeline: Pipeline): Promise<void> {
  for (const step of pipeline.steps) {
    const name = step.command.slice(1).split(" ")[0] ?? "";
    await target.writeFile(`.claude/skills/${name}/SKILL.md`, `# ${name}\n`);
  }
  await target.git("add", "-A");
  await target.git("commit", "-m", "instala skills");
}

function twoStepPipeline(overrides: Partial<Pipeline["steps"][number]>[] = []): Pipeline {
  const base = createDefaultPipeline(NOW);
  const steps = [
    { ...base.steps[0]!, ...overrides[0] },
    { ...base.steps[2]!, ...overrides[1] },
  ];
  return { ...base, id: "22222222-2222-4222-8222-222222222222", isDefault: false, name: "Duas etapas", steps };
}

async function start(
  pipeline: Pipeline,
  overrides: { expectedBranch?: string; description?: string; yolo?: boolean } = {},
): Promise<Run> {
  return executor.start({
    repoPath: repo.path,
    pipeline,
    description: overrides.description ?? DESCRIPTION,
    expectedBranch: overrides.expectedBranch ?? "main",
    yolo: overrides.yolo ?? false,
  });
}

async function finished(): Promise<Run> {
  await executor.whenIdle();
  const run = executor.getActiveRun() ?? (await runStore.get(lastRunId()));
  return run;
}

function lastRunId(): string {
  const last = [...events].reverse().find((event) => event.type === "run.updated" || event.type === "run.finished");
  if (!last || !("run" in last)) throw new Error("nenhum run emitido");
  return last.run.id;
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

async function commitMessages(): Promise<string[]> {
  return (await repo.git("log", "--format=%s")).split("\n");
}

beforeEach(async () => {
  repo = await createTempRepo();
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-executor-"));
  runStore = new RunStore(dataDir);
  settingsStore = new SettingsStore(dataDir);
  events = [];
  pushed = [];
  lock = new RunLock();
  fileCounter = 0;
});

afterEach(async () => {
  await executor?.whenIdle();
  await repo.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

describe("PipelineExecutor (US1): validação na partida", () => {
  beforeEach(() => {
    makeExecutor();
  });

  it("recusa repositório sujo com REPO_REJECTED, sem criar branch", async () => {
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    await repo.writeFile("sujo.txt", "x");
    const error = await expectApiError(start(pipeline), 422, "REPO_REJECTED");
    expect(error.details).toEqual({ problems: ["dirty_worktree"] });
    expect(await repo.git("branch", "--list", "orchestrator/*")).toBe("");
    expect(lock.activeRunId).toBeNull();
  });

  it("recusa merge em andamento", async () => {
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const head = await repo.git("rev-parse", "HEAD");
    await writeFile(join(repo.path, ".git", "MERGE_HEAD"), `${head}\n`);
    const error = await expectApiError(start(pipeline), 422, "REPO_REJECTED");
    expect(error.details).toEqual({ problems: ["merge_or_rebase_in_progress"] });
  });

  it("recusa HEAD destacado", async () => {
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    await repo.git("switch", "--detach", "HEAD");
    const error = await expectApiError(start(pipeline, { expectedBranch: "main" }), 422, "REPO_REJECTED");
    expect(error.details).toEqual({ problems: ["detached_head"] });
    expect(await repo.git("branch", "--list", "orchestrator/*")).toBe("");
  });

  it("expectedBranch diferente → BRANCH_CHANGED com details.currentBranch, sem branch e sem lock", async () => {
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const error = await expectApiError(start(pipeline, { expectedBranch: "develop" }), 409, "BRANCH_CHANGED");
    expect(error.details).toEqual({ currentBranch: "main" });
    expect(await repo.git("branch", "--list", "orchestrator/*")).toBe("");
    expect(lock.activeRunId).toBeNull();
  });

  it("falha ao criar a branch → REPO_REJECTED e o lock é liberado", async () => {
    const date = new Date("2026-11-17T12:00:00Z");
    makeExecutor([], { sideEffect: writesFile }, () => date);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const taken = buildRunBranchName(DESCRIPTION, date);
    await repo.git("branch", taken);

    const error = await expectApiError(start(pipeline), 422, "REPO_REJECTED");
    expect(error.message).toContain(taken);
    expect(lock.activeRunId).toBeNull();
    expect(await repo.git("branch", "--show-current")).toBe("main");

    await repo.git("branch", "-D", taken);
    const run = await start(pipeline);
    expect(run.status).toBe("running");
  });

  it("segunda chamada a start com run ativo → RUN_ALREADY_ACTIVE", async () => {
    const pipeline = twoStepPipeline([{}, { interactive: true }]);
    await installCommands(repo, pipeline);
    await start(pipeline);
    await executor.whenIdle();
    expect(executor.getActiveRun()?.status).toBe("awaiting_input");
    await expectApiError(start(pipeline), 409, "RUN_ALREADY_ACTIVE");
  });

  it("esteira inválida → PIPELINE_INVALID com issues, sem criar branch nem ocupar o lock (FR-024)", async () => {
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const invalid = { ...pipeline, steps: [{ ...pipeline.steps[0]!, timeoutMinutes: 0 }] };
    const error = await expectApiError(start(invalid), 422, "PIPELINE_INVALID");
    expect(error.issues).toContainEqual({
      path: ["steps", 0, "timeoutMinutes"],
      message: "O limite de tempo deve estar entre 1 e 1440 minutos",
    });
    expect(await repo.git("branch", "--list", "orchestrator/*")).toBe("");
    expect(lock.activeRunId).toBeNull();
  });
});

describe("PipelineExecutor (US1): esteira padrão de ponta a ponta", () => {
  it("roda os passos em ordem, com commits, pausas interativas, respostas e branch final", async () => {
    makeExecutor();
    const pipeline = createDefaultPipeline(NOW);
    await installCommands(repo, pipeline);
    const mainSha = await repo.git("rev-parse", "main");

    const created = await start(pipeline);
    expect(created.initialBranch).toMatch(/^orchestrator\/\d{8}-\d{6}-adicionar-login-com-e-mail$/);
    expect(created.sourceBranch).toBe("main");
    expect(created.refSnapshot).toContainEqual({ ref: "refs/heads/main", sha: mainSha });
    expect(created.createdBranches).toEqual([created.initialBranch]);
    expect(created.steps.every((step) => step.status === "waiting" || step.status === "running")).toBe(true);
    expect(await repo.git("branch", "--show-current")).toBe(created.initialBranch);
    expect((await settingsStore.get()).recentRepos[0]).toBe(created.repoPath);

    // Specify (não interativo) conclui e Clarify (interativo) pausa
    await executor.whenIdle();
    let run = executor.getActiveRun()!;
    expect(run.status).toBe("awaiting_input");
    expect(run.steps.map((step) => step.status)).toEqual([
      "completed",
      "awaiting_input",
      "waiting",
      "waiting",
      "waiting",
    ]);
    expect(run.steps[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(run.steps[1]?.commitSha).toBeNull();
    expect(await commitMessages()).toContain("orchestrator: Specify concluído");
    const trailer = await gitIn(repo.path, "log", "-1", "--format=%(trailers:key=Orchestrator-Run,valueonly)", run.steps[0]!.commitSha!);
    expect(trailer.trim()).toBe(run.id);

    // prompts, modelos e sessões
    expect(runner.invocations[0]).toMatchObject({
      prompt: `/speckit-specify ${DESCRIPTION}`,
      model: "sonnet",
      resume: false,
      interactive: false,
      priorSessionCostUsd: 0,
    });
    expect(runner.invocations[1]).toMatchObject({ prompt: "/speckit-clarify", model: "sonnet", resume: false, interactive: true });
    expect(runner.invocations[0]?.sessionId).not.toBe(runner.invocations[1]?.sessionId);
    expect(run.steps[1]?.sessionId).toBe(runner.invocations[1]?.sessionId);

    // resposta: mesma sessão, resume, registrada e de volta a awaiting_input
    await executor.reply(run.id, "Use autenticação por e-mail e senha");
    expect(executor.getActiveRun()?.steps[1]?.status).toBe("running");
    await executor.whenIdle();
    run = executor.getActiveRun()!;
    expect(runner.invocations[2]).toMatchObject({
      prompt: "Use autenticação por e-mail e senha",
      resume: true,
      sessionId: runner.invocations[1]?.sessionId,
    });
    expect(run.steps[1]?.status).toBe("awaiting_input");
    expect(run.steps[1]?.replies.map((reply) => reply.text)).toEqual(["Use autenticação por e-mail e senha"]);
    const clarifyOutput = await runStore.readOutput(run.id, 1);
    expect(clarifyOutput).toContainEqual(
      expect.objectContaining({ kind: "user_reply", text: "Use autenticação por e-mail e senha" }),
    );

    // avançar: commit do Clarify, Plan e Tasks rodam, Implement pausa
    await executor.advance(run.id);
    await executor.whenIdle();
    run = executor.getActiveRun()!;
    expect(run.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "awaiting_input",
    ]);
    expect(runner.invocations.slice(3).map((inv) => [inv.prompt, inv.model])).toEqual([
      ["/speckit-plan", "opus"],
      ["/speckit-tasks", "sonnet"],
      ["/speckit-implement", "sonnet"],
    ]);

    // avançar o último passo encerra a execução
    await executor.advance(run.id);
    await executor.whenIdle();
    expect(executor.getActiveRun()).toBeNull();
    const done = await runStore.get(run.id);
    expect(done.status).toBe("completed");
    expect(done.finalBranch).toBe(created.initialBranch);
    expect(done.finishedAt).not.toBeNull();
    expect(done.steps.every((step) => step.status === "completed")).toBe(true);
    expect(await commitMessages()).toEqual(
      expect.arrayContaining([
        "orchestrator: Specify concluído",
        "orchestrator: Clarify concluído",
        "orchestrator: Plan concluído",
        "orchestrator: Tasks concluído",
        "orchestrator: Implement concluído",
      ]),
    );
    expect(await repo.git("rev-parse", "main")).toBe(mainSha);
    expect(lock.activeRunId).toBeNull();

    // eventos: run.updated a cada mudança e run.finished no fim
    expect(events.filter((event) => event.type === "run.updated").length).toBeGreaterThan(5);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", run: { id: run.id, status: "completed" } });
  });

  it("grava o prompt de cada Invocation e a entrada system 'Entrada: <prompt>' na invocação inicial", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    const done = await finished();
    expect(done.steps[0]?.invocations.map((inv) => inv.prompt)).toEqual([`/speckit-specify ${DESCRIPTION}`]);
    expect(done.steps[1]?.invocations.map((inv) => inv.prompt)).toEqual(["/speckit-plan"]);
    const output = await runStore.readOutput(run.id, 0);
    expect(output[0]).toMatchObject({ seq: 1, kind: "system", text: `Entrada: /speckit-specify ${DESCRIPTION}` });
  });

  it("grava a saída do agente com seq monotônico", async () => {
    makeExecutor([
      {
        outputs: [
          { kind: "text", text: "olá" },
          { kind: "tool_use", text: "Bash: ls" },
        ],
        sideEffect: writesFile,
      },
    ]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await finished();
    const output = await runStore.readOutput(run.id, 0);
    expect(output.map((entry) => [entry.seq, entry.kind])).toEqual([
      [1, "system"],
      [2, "text"],
      [3, "tool_use"],
    ]);
  });
});

describe("PipelineExecutor (US1): consumo e duração", () => {
  it("soma durationMs e usage das invocações sem contar o custo acumulado da sessão", async () => {
    makeExecutor([
      { sideEffect: writesFile, usage: usage(0.13), sessionCostUsd: 0.13, delayMs: 5 },
      { sideEffect: writesFile, usage: usage(0.007), sessionCostUsd: 0.137, delayMs: 5 },
    ]);
    const pipeline = twoStepPipeline([{ interactive: true }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();
    await executor.reply(run.id, "mais detalhes");
    await executor.whenIdle();

    expect(runner.invocations[0]?.priorSessionCostUsd).toBe(0);
    expect(runner.invocations[1]?.priorSessionCostUsd).toBe(0.13);

    const step = executor.getActiveRun()!.steps[0]!;
    expect(step.invocations.map((inv) => inv.sessionCostUsd)).toEqual([0.13, 0.137]);
    expect(step.usage?.costUsd).toBeCloseTo(0.137, 10);
    expect(step.usage).toMatchObject({ inputTokens: 20, outputTokens: 10, numTurns: 2 });
    expect(step.durationMs).toBe(step.invocations.reduce((sum, inv) => sum + inv.durationMs, 0));
  });
});

describe("PipelineExecutor (US1): branches e verificação de refs", () => {
  it("passo que cria e troca para uma branch nova → commit nela e ela entra em createdBranches", async () => {
    makeExecutor([
      {
        sideEffect: async (cwd) => {
          await gitIn(cwd, "switch", "-c", "001-login");
          await writeFile(join(cwd, "spec.md"), "spec\n");
        },
      },
    ]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    const done = await finished();
    expect(done.status).toBe("completed");
    expect(done.createdBranches).toEqual([run.initialBranch, "001-login"]);
    expect(done.steps[0]?.branchAtEnd).toBe("001-login");
    expect(await gitIn(repo.path, "log", "-1", "--format=%s", "001-login")).toBe("orchestrator: Plan concluído");
    expect(done.finalBranch).toBe("001-login");
  });

  it("passo que termina em branch pré-existente → failed citando a branch, sem commit, restantes waiting", async () => {
    makeExecutor([
      {
        sideEffect: async (cwd) => {
          await writeFile(join(cwd, "x.md"), "x\n");
          await gitIn(cwd, "switch", "main");
        },
      },
    ]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const mainSha = await repo.git("rev-parse", "main");
    await start(pipeline);
    const done = await finished();
    expect(done.status).toBe("failed");
    expect(done.steps[0]?.status).toBe("failed");
    expect(done.steps[0]?.errorMessage).toContain("refs/heads/main");
    expect(done.steps[0]?.commitSha).toBeNull();
    expect(done.steps[1]?.status).toBe("waiting");
    expect(await repo.git("rev-parse", "main")).toBe(mainSha);
    expect(runner.invocations).toHaveLength(1);
    expect(lock.activeRunId).toBeNull();
  });

  it("tag criada pelo passo → failed sem commit", async () => {
    makeExecutor([
      {
        sideEffect: async (cwd) => {
          await writeFile(join(cwd, "x.md"), "x\n");
          await gitIn(cwd, "tag", "v9.9");
        },
      },
    ]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    await start(pipeline);
    const done = await finished();
    expect(done.status).toBe("failed");
    expect(done.steps[0]?.errorMessage).toContain("refs/tags/v9.9");
    expect(done.steps[0]?.commitSha).toBeNull();
    expect(await commitMessages()).not.toContain("WIP: passo Specify com erro");
  });

  it("advance com violação de refs durante a pausa → failed, sem commit, run failed", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline([{ interactive: true }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("awaiting_input");

    await repo.git("add", "-A");
    await repo.git("stash");
    await repo.git("switch", "main");
    await executor.advance(run.id);
    await executor.whenIdle();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("failed");
    expect(done.steps[0]?.status).toBe("failed");
    expect(done.steps[0]?.errorMessage).toContain("refs/heads/main");
    expect(done.steps[0]?.commitSha).toBeNull();
    expect(done.steps[1]?.status).toBe("waiting");
    expect(runner.invocations).toHaveLength(1);
    expect(lock.activeRunId).toBeNull();
  });
});

describe("PipelineExecutor (US1): erros", () => {
  it("agente com error → failed com errorMessage, commit WIP com erro, run failed", async () => {
    makeExecutor([{ sideEffect: writesFile, result: "error", errorMessage: "modelo indisponível" }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    await start(pipeline);
    const done = await finished();
    expect(done.status).toBe("failed");
    expect(done.steps[0]).toMatchObject({ status: "failed", errorMessage: "modelo indisponível" });
    expect(done.steps[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitMessages()).toContain("WIP: passo Specify com erro");
    expect(done.steps[1]?.status).toBe("waiting");
  });

  it("agente com error sem alterações → failed sem commit", async () => {
    makeExecutor([{ result: "error", errorMessage: "falhou" }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    await start(pipeline);
    const done = await finished();
    expect(done.steps[0]?.status).toBe("failed");
    expect(done.steps[0]?.commitSha).toBeNull();
  });

  it("comando inexistente → failed sem invocar o agente", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline();
    await installCommands(repo, { ...pipeline, steps: [pipeline.steps[1]!] });
    await start(pipeline);
    const done = await finished();
    expect(done.status).toBe("failed");
    expect(done.steps[0]?.status).toBe("failed");
    expect(done.steps[0]?.errorMessage).toContain("/speckit-specify");
    expect(runner.invocations).toHaveLength(0);
  });

  it("reply e advance fora de awaiting_input → INVALID_STATE", async () => {
    makeExecutor([{ sideEffect: writesFile, delayMs: 200 }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await expectApiError(executor.reply(run.id, "oi"), 409, "INVALID_STATE");
    await expectApiError(executor.advance(run.id), 409, "INVALID_STATE");
    await executor.whenIdle();
    await expectApiError(executor.advance(run.id), 409, "INVALID_STATE");
  });

  it("reply e advance em execução inexistente → NOT_FOUND", async () => {
    makeExecutor();
    await expectApiError(executor.reply("33333333-3333-4333-8333-333333333333", "oi"), 404, "NOT_FOUND");
    await expectApiError(executor.advance("33333333-3333-4333-8333-333333333333"), 404, "NOT_FOUND");
  });
});

describe("PipelineExecutor (US2): saída em tempo real", () => {
  it("envia cada entrada ao eventHub.pushOutput na ordem, depois de gravá-la no .jsonl", async () => {
    makeExecutor([
      {
        outputs: [
          { kind: "text", text: "olá" },
          { kind: "tool_use", text: "Bash: ls" },
        ],
        sideEffect: writesFile,
      },
    ]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await finished();
    for (const index of [0, 1]) {
      const stored = await runStore.readOutput(run.id, index);
      const sent = pushed.filter((item) => item.stepIndex === index).map((item) => item.entry);
      expect(sent).toEqual(stored);
    }
    expect(pushed.every((item) => item.runId === run.id)).toBe(true);
    expect(pushed.filter((item) => item.stepIndex === 0).map((item) => item.entry.text)).toEqual([
      `Entrada: /speckit-specify ${DESCRIPTION}`,
      "olá",
      "Bash: ls",
    ]);
  });

  it("user_reply também é enviado como saída", async () => {
    makeExecutor([{ sideEffect: writesFile }]);
    const pipeline = twoStepPipeline([{ interactive: true }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();
    await executor.reply(run.id, "Use OAuth");
    await executor.whenIdle();
    expect(pushed.map((item) => item.entry)).toContainEqual(expect.objectContaining({ kind: "user_reply", text: "Use OAuth" }));
  });

  it("passo que falha gera uma entrada error com a mensagem, gravada e enviada", async () => {
    makeExecutor([{ result: "error", errorMessage: "modelo indisponível" }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await finished();
    const stored = await runStore.readOutput(run.id, 0);
    expect(stored.at(-1)).toMatchObject({ kind: "error", text: "modelo indisponível" });
    expect(pushed.at(-1)?.entry).toEqual(stored.at(-1));
  });

  it("violação de refs gera uma entrada error citando a ref", async () => {
    makeExecutor([{ sideEffect: async (cwd) => void (await gitIn(cwd, "tag", "v-proibida")) }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await finished();
    const stored = await runStore.readOutput(run.id, 0);
    expect(stored.at(-1)?.kind).toBe("error");
    expect(stored.at(-1)?.text).toContain("refs/tags/v-proibida");
  });
});

// ------------------------------------------------------------------------------------------------
// US3: interromper, limite de tempo e encerramento do servidor
// ------------------------------------------------------------------------------------------------

/** Agente que trabalha por muito tempo (só termina se abortado). */
const LONG = 10 * 60 * 60_000;

/**
 * Espera a condição girando o laço de eventos com `setImmediate` (não falsificado): funciona com
 * `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` sem avançar o relógio falso.
 */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("tempo esgotado esperando a condição");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Gira o laço de eventos por um tempo real curto, para o executor reagir (ou não) ao relógio falso. */
async function settle(ms = 150): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
}

const useFakeClock = (): void => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
};

describe("PipelineExecutor (US3): interromper", () => {
  afterEach(async () => {
    await executor.shutdown();
    vi.useRealTimers();
  });

  it("interrupt em running → passo interrupted (user), commit WIP, run interrupted, restantes waiting, lock liberado", async () => {
    makeExecutor([{ sideEffect: writesFile, delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const mainSha = await repo.git("rev-parse", "main");
    const run = await start(pipeline);
    await until(() => runner.invocations.length === 1);

    await executor.interrupt(run.id);
    await executor.whenIdle();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.finishedAt).not.toBeNull();
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "user" });
    expect(done.steps[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(done.steps[0]?.invocations.at(-1)?.outcome).toBe("interrupted");
    expect(done.steps[1]?.status).toBe("waiting");
    expect(await commitMessages()).toContain("WIP: passo Specify interrompido");
    expect(await repo.git("rev-parse", "main")).toBe(mainSha);
    expect(lock.activeRunId).toBeNull();
    expect(executor.getActiveRun()).toBeNull();
    expect(runner.invocations).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", run: { id: run.id, status: "interrupted" } });
  });

  it("interrupt em running sem alterações → nenhum commit", async () => {
    makeExecutor([{ delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => runner.invocations.length === 1);
    await executor.interrupt(run.id);
    await executor.whenIdle();
    const done = await runStore.get(run.id);
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "user", commitSha: null });
    expect(await commitMessages()).not.toContain("WIP: passo Specify interrompido");
  });

  it("interrupt em awaiting_input → interrupted com commit WIP, sem nova invocação", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline([{ interactive: true }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("awaiting_input");

    await executor.interrupt(run.id);
    await executor.whenIdle();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "user" });
    expect(done.steps[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(done.steps[1]?.status).toBe("waiting");
    expect(await commitMessages()).toContain("WIP: passo Specify interrompido");
    expect(runner.invocations).toHaveLength(1);
    expect(lock.activeRunId).toBeNull();
  });

  it("interrupt em run terminal → INVALID_STATE; em run inexistente → NOT_FOUND", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();
    expect((await runStore.get(run.id)).status).toBe("completed");
    await expectApiError(executor.interrupt(run.id), 409, "INVALID_STATE");
    await expectApiError(executor.interrupt("33333333-3333-4333-8333-333333333333"), 404, "NOT_FOUND");
  });

  it("violação de refs num passo interrompido em running → continua interrupted, sem commit, errorMessage com a violação", async () => {
    makeExecutor([
      {
        delayMs: LONG,
        sideEffect: async (cwd) => {
          await writeFile(join(cwd, "x.md"), "x\n");
          await gitIn(cwd, "switch", "main");
        },
      },
    ]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const mainSha = await repo.git("rev-parse", "main");
    const run = await start(pipeline);
    await until(() => runner.invocations.length === 1);
    await executor.interrupt(run.id);
    await executor.whenIdle();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "user", commitSha: null });
    expect(done.steps[0]?.errorMessage).toContain("refs/heads/main");
    expect(await commitMessages()).not.toContain("WIP: passo Specify interrompido");
    expect(await repo.git("rev-parse", "main")).toBe(mainSha);
  });

  it("violação de refs num passo interrompido em awaiting_input → continua interrupted, sem commit", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline([{ interactive: true }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();
    await repo.git("add", "-A");
    await repo.git("stash");
    await repo.git("switch", "main");

    await executor.interrupt(run.id);
    await executor.whenIdle();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "user", commitSha: null });
    expect(done.steps[0]?.errorMessage).toContain("refs/heads/main");
    expect(lock.activeRunId).toBeNull();
  });
});

describe("PipelineExecutor (US3): limite de tempo", () => {
  afterEach(async () => {
    await executor.shutdown();
    vi.useRealTimers();
  });

  it("dispara exatamente em timeoutMinutes × 60 000 ms, com interruptReason timeout e commit WIP", async () => {
    useFakeClock();
    makeExecutor([{ sideEffect: writesFile, delayMs: LONG }]);
    const pipeline = twoStepPipeline([{ timeoutMinutes: 5 }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => runner.invocations.length === 1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await settle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(1);
    await until(() => executor.getActiveRun() === null);
    await executor.whenIdle();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "timeout" });
    expect(done.steps[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(done.steps[1]?.status).toBe("waiting");
    expect(runner.invocations).toHaveLength(1);
  });

  it("passo sem timeoutMinutes usa 30 min", async () => {
    useFakeClock();
    makeExecutor([{ delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    expect(pipeline.steps[0]?.timeoutMinutes).toBeUndefined();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => runner.invocations.length === 1);

    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    await settle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(1);
    await until(() => executor.getActiveRun() === null);
    expect((await runStore.get(run.id)).steps[0]?.interruptReason).toBe("timeout");
  });

  it("a pausa em awaiting_input não conta e cada reply recebe o limite completo", async () => {
    useFakeClock();
    makeExecutor([{ sideEffect: writesFile }, { delayMs: LONG }]);
    const pipeline = twoStepPipeline([{ interactive: true, timeoutMinutes: 5 }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => executor.getActiveRun()?.steps[0]?.status === "awaiting_input");

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    await settle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("awaiting_input");

    await executor.reply(run.id, "continue");
    await until(() => runner.invocations.length === 2);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await settle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(1);
    await until(() => executor.getActiveRun() === null);
    const done = await runStore.get(run.id);
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "timeout" });
  });

  it("invocação que termina antes do limite cancela o timer", async () => {
    useFakeClock();
    makeExecutor([{ sideEffect: writesFile }]);
    const pipeline = twoStepPipeline([{ interactive: true, timeoutMinutes: 1 }]);
    await installCommands(repo, pipeline);
    await start(pipeline);
    await until(() => executor.getActiveRun()?.steps[0]?.status === "awaiting_input");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("PipelineExecutor (US3): shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shutdown em running interrompe com server_shutdown, faz o commit WIP e persiste antes de resolver", async () => {
    makeExecutor([{ sideEffect: writesFile, delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => runner.invocations.length === 1);

    await executor.shutdown();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "server_shutdown" });
    expect(done.steps[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitMessages()).toContain("WIP: passo Specify interrompido");
    expect(lock.activeRunId).toBeNull();
    expect(executor.getActiveRun()).toBeNull();
  });

  it("shutdown em awaiting_input → interrupted com server_shutdown", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline([{ interactive: true }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();

    await executor.shutdown();

    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "server_shutdown" });
    expect(done.steps[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("shutdown sem run ativo resolve sem efeito", async () => {
    makeExecutor();
    await expect(executor.shutdown()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });
});

describe("PipelineExecutor (US6): permissões e Modo Yolo", () => {
  const NPM_TEST = { toolName: "Bash", input: { command: "npm test", description: "roda os testes" } };

  afterEach(async () => {
    await executor.shutdown();
    vi.useRealTimers();
  });

  /** Pedidos do 1º passo no run em memória. */
  const requests = () => executor.getActiveRun()?.steps[0]?.permissionRequests ?? [];
  const pendingIds = () => requests().filter((request) => request.status === "pending").map((request) => request.id);
  const systemTexts = async (runId: string) =>
    (await runStore.readOutput(runId, 0)).filter((entry) => entry.kind === "system").map((entry) => entry.text);

  it("Yolo: invocação sem canal de permissão e nenhum pedido criado", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST] }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline, { yolo: true });
    expect(run.yolo).toBe(true);
    await executor.whenIdle();
    expect(runner.invocations[0]?.permissionChannel).toBeNull();
    const done = await runStore.get(run.id);
    expect(done.status).toBe("completed");
    expect(done.steps.flatMap((step) => step.permissionRequests)).toEqual([]);
    expect(runner.permissionDecisions).toEqual([]);
  });

  it("sem Yolo: cada invocação recebe um canal próprio, fechado ao terminar", async () => {
    makeExecutor();
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    expect(run.yolo).toBe(false);
    await executor.whenIdle();
    const channels = runner.invocations.map((invocation) => invocation.permissionChannel);
    expect(channels).toHaveLength(2);
    expect(channels[0]?.url).toBe("http://127.0.0.1:1/internal/permission-requests");
    expect(channels[0]?.token).not.toBe(channels[1]?.token);
    for (const channel of channels) expect(broker.hasChannel(channel!.token)).toBe(false);
  });

  it("pedido → passo e run awaiting_permission; allow_once → fake recebe allow, passo volta a running e conclui", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST], sideEffect: writesFile }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 1);

    const active = executor.getActiveRun()!;
    expect(active.status).toBe("awaiting_permission");
    expect(active.steps[0]?.status).toBe("awaiting_permission");
    expect(active.steps[0]?.permissionRequests[0]).toMatchObject({
      status: "pending",
      toolName: "Bash",
      input: NPM_TEST.input,
      summary: "Bash: npm test",
      rule: null,
      decidedAt: null,
    });
    // O run.updated sai depois da gravação do run.json.
    await until(() => events.some((event) => event.type === "run.updated" && event.run.status === "awaiting_permission"));
    expect((await runStore.get(run.id)).status).toBe("awaiting_permission");

    await executor.decidePermission(run.id, pendingIds()[0]!, "allow_once");
    await executor.whenIdle();

    expect(runner.permissionDecisions).toEqual([{ behavior: "allow", updatedInput: NPM_TEST.input }]);
    const done = await runStore.get(run.id);
    expect(done.status).toBe("completed");
    expect(done.steps[0]?.permissionRequests[0]).toMatchObject({ status: "allowed_once", rule: null });
    expect(done.steps[0]?.permissionRequests[0]?.decidedAt).not.toBeNull();
    const texts = await systemTexts(run.id);
    expect(texts).toContain("Permissão pedida: Bash: npm test");
    expect(texts).toContain("Permitido uma vez: Bash: npm test");
  });

  it("allow_always cria a regra; um pedido seguinte com o mesmo prefixo vira auto_allowed sem pausar", async () => {
    const again = { toolName: "Bash", input: { command: "npm test -- --run" } };
    makeExecutor([{ permissionRequests: [NPM_TEST, again] }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 1);
    const before = events.length;

    await executor.decidePermission(run.id, pendingIds()[0]!, "allow_always");
    await executor.whenIdle();
    const statuses = events.slice(before).flatMap((event) => ("run" in event && event.run ? [event.run.status] : []));

    const done = await runStore.get(run.id);
    expect(done.permissionRules).toEqual(["Bash(npm test:*)"]);
    expect(done.steps[0]?.permissionRequests.map((request) => [request.status, request.rule])).toEqual([
      ["allowed_always", "Bash(npm test:*)"],
      ["auto_allowed", "Bash(npm test:*)"],
    ]);
    expect(runner.permissionDecisions).toEqual([
      { behavior: "allow", updatedInput: NPM_TEST.input },
      { behavior: "allow", updatedInput: again.input },
    ]);
    // Depois da decisão, o passo não voltou a pausar.
    expect(statuses).not.toContain("awaiting_permission");
    expect(await systemTexts(run.id)).toContain("Permitido sempre: Bash(npm test:*)");
  });

  it("deny → fake recebe deny com a mensagem do orquestrador", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST] }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 1);
    await executor.decidePermission(run.id, pendingIds()[0]!, "deny");
    await executor.whenIdle();
    expect(runner.permissionDecisions).toEqual([{ behavior: "deny", message: "Negado pelo usuário no orquestrador." }]);
    const done = await runStore.get(run.id);
    expect(done.steps[0]?.permissionRequests[0]?.status).toBe("denied");
    expect(await systemTexts(run.id)).toContain("Negado: Bash: npm test");
  });

  it("dois pedidos em paralelo: o passo só volta a running depois de decidir os dois", async () => {
    const other = { toolName: "Bash", input: { command: "make build" } };
    makeExecutor([{ permissionRequests: [NPM_TEST, other], parallelPermissions: true, delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 2);
    const [first, second] = pendingIds();

    await executor.decidePermission(run.id, first!, "allow_once");
    expect(executor.getActiveRun()?.status).toBe("awaiting_permission");
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("awaiting_permission");

    await executor.decidePermission(run.id, second!, "deny");
    expect(executor.getActiveRun()?.status).toBe("running");
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("running");
    await until(() => runner.permissionDecisions.length === 2);
  });

  it("o tempo esperando a decisão não conta para o limite do passo", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    makeExecutor([
      {
        outputs: [
          { kind: "text", text: "trabalhando" },
          { kind: "text", text: "preciso rodar os testes" },
        ],
        outputIntervalMs: 30_000,
        permissionRequests: [NPM_TEST],
        delayMs: LONG,
      },
    ]);
    const pipeline = twoStepPipeline([{ timeoutMinutes: 1 }]);
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => runner.invocations.length === 1);

    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => pendingIds().length === 1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("awaiting_permission");

    await executor.decidePermission(run.id, pendingIds()[0]!, "allow_once");
    await vi.advanceTimersByTimeAsync(29_000);
    await settle();
    expect(executor.getActiveRun()?.steps[0]?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => executor.getActiveRun() === null);
    const done = await runStore.get(run.id);
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "timeout" });
  });

  it("interromper com pedido pendente: fake recebe deny, pedido cancelled, passo interrupted (user)", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST], delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 1);

    await executor.interrupt(run.id);
    await executor.whenIdle();

    expect(runner.permissionDecisions).toEqual([{ behavior: "deny", message: "Execução interrompida." }]);
    const done = await runStore.get(run.id);
    expect(done.status).toBe("interrupted");
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "user" });
    expect(done.steps[0]?.permissionRequests[0]?.status).toBe("cancelled");
    expect(done.steps[1]?.status).toBe("waiting");
    expect(lock.activeRunId).toBeNull();
  });

  it("shutdown com pedido pendente → interrupted (server_shutdown) e pedido cancelled", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST], delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 1);
    await executor.shutdown();
    const done = await runStore.get(run.id);
    expect(done.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "server_shutdown" });
    expect(done.steps[0]?.permissionRequests[0]?.status).toBe("cancelled");
  });

  it("decidir duas vezes o mesmo pedido → a segunda lança 409 INVALID_STATE e a CLI recebe uma só decisão", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST], delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 1);
    const id = pendingIds()[0]!;
    await executor.decidePermission(run.id, id, "allow_once");
    await expectApiError(executor.decidePermission(run.id, id, "allow_once"), 409, "INVALID_STATE");
    await until(() => runner.permissionDecisions.length === 1);
    await settle();
    expect(runner.permissionDecisions).toHaveLength(1);
  });

  it("decidePermission com pedido ou execução inexistente → 404", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST], delayMs: LONG }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await until(() => pendingIds().length === 1);
    const missing = "99999999-9999-4999-8999-999999999999";
    await expectApiError(executor.decidePermission(run.id, missing, "deny"), 404, "NOT_FOUND");
    await expectApiError(executor.decidePermission(missing, pendingIds()[0]!, "deny"), 404, "NOT_FOUND");
  });

  it("invocação que termina com pedido pendente (a CLI desistiu) → pedido cancelled e o passo segue", async () => {
    makeExecutor([{ permissionRequests: [NPM_TEST], abandonPermissions: true }]);
    const pipeline = twoStepPipeline();
    await installCommands(repo, pipeline);
    const run = await start(pipeline);
    await executor.whenIdle();
    const done = await runStore.get(run.id);
    expect(done.status).toBe("completed");
    expect(done.steps[0]?.permissionRequests[0]?.status).toBe("cancelled");
    expect(await systemTexts(run.id)).toContain(
      "Pedido de permissão cancelado (A CLI desistiu de esperar pela decisão): Bash: npm test",
    );
  });
});
