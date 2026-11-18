import { randomUUID } from "node:crypto";
import {
  computeRunTotals,
  type Invocation,
  type OutputEntry,
  type Pipeline,
  type RepoInfo,
  type RepoProblem,
  type Run,
  type ServerEvent,
  type StepRun,
  type StepStatus,
} from "@orchestrator/shared";
import type { AgentOutcome, AgentRunner } from "../agent/agent-runner.js";
import { commandExists as defaultCommandExists } from "../agent/command-lookup.js";
import { GitService, type VerifyResult } from "../git/git-service.js";
import { ApiError } from "../http/errors.js";
import type { RunStore } from "../storage/run-store.js";
import type { SettingsStore } from "../storage/settings-store.js";
import { runAlreadyActive, type RunLock } from "./run-lock.js";
import { transitionRun, transitionStep, type StepEvent } from "./state-machine.js";

export interface PipelineExecutorDeps {
  agentRunner: AgentRunner;
  runStore: RunStore;
  settingsStore: SettingsStore;
  /** `broadcast` para eventos `run.*`; `pushOutput` para a saída dos passos, em lotes (SC-003). */
  eventHub: {
    broadcast(event: ServerEvent): void;
    pushOutput(runId: string, stepIndex: number, entry: OutputEntry): void;
  };
  lock: RunLock;
  /** Fábrica do `GitService` do repositório alvo (padrão: `new GitService(path)`). */
  git?: (repoPath: string) => GitService;
  /** Validações de FR-002/FR-003a (padrão: `GitService.inspect`). */
  inspect?: (path: string) => Promise<RepoInfo>;
  /** Pré-verificação do comando (padrão: `commandExists` de agent/command-lookup). */
  commandExists?: (repoPath: string, prompt: string) => Promise<boolean>;
  clock?: () => Date;
}

export interface StartRunInput {
  repoPath: string;
  pipeline: Pipeline;
  description: string;
  /** Branch exibida na tela no momento do envio (FR-003a). */
  expectedBranch: string;
}

interface ActiveRun {
  run: Run;
  git: GitService;
  /** `true` enquanto um `advance` verifica e commita (evita dois avanços simultâneos). */
  busy: boolean;
}

const TERMINAL_RUN = new Set<Run["status"]>(["completed", "failed", "interrupted"]);
const TERMINAL_STEP = new Set<StepStatus>(["completed", "failed", "interrupted"]);

const PROBLEM_TEXT: Record<RepoProblem, string> = {
  not_a_repo: "a pasta não é um repositório Git",
  dirty_worktree: "há alterações não commitadas",
  merge_or_rebase_in_progress: "há merge/rebase em andamento",
  detached_head: "HEAD destacado: troque para uma branch",
  path_not_found: "pasta não encontrada",
};

/**
 * Executa uma esteira passo a passo (data-model.md, "Máquina de estados"): cria a branch da execução,
 * invoca o agente, verifica as refs, commita e pausa nos passos interativos. Toda mudança grava o
 * `run.json` e emite `run.updated` no mesmo tick; o estado terminal emite `run.finished`.
 */
export class PipelineExecutor {
  private active: ActiveRun | null = null;
  private background: Promise<void> = Promise.resolve();
  private readonly clock: () => Date;
  private readonly gitFor: (repoPath: string) => GitService;
  private readonly inspect: (path: string) => Promise<RepoInfo>;
  private readonly commandExists: (repoPath: string, prompt: string) => Promise<boolean>;

  constructor(private readonly deps: PipelineExecutorDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.gitFor = deps.git ?? ((repoPath) => new GitService(repoPath));
    this.inspect = deps.inspect ?? ((path) => GitService.inspect(path));
    this.commandExists = deps.commandExists ?? defaultCommandExists;
  }

  /** Cópia do run ativo, ou `null`. */
  getActiveRun(): Run | null {
    return this.active ? structuredClone(this.active.run) : null;
  }

  /** Run ativo (em memória) ou gravado; `404 NOT_FOUND` se não existir. */
  async getRun(id: string): Promise<Run> {
    if (this.active?.run.id === id) return structuredClone(this.active.run);
    return this.deps.runStore.get(id);
  }

  /** Resolve quando não há trabalho em segundo plano pendente (usado pelos testes e no shutdown). */
  async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.background;
      await current;
    } while (current !== this.background);
  }

  async start(input: StartRunInput): Promise<Run> {
    const { lock } = this.deps;
    if (lock.activeRunId !== null) throw runAlreadyActive(lock.activeRunId);

    const info = await this.inspect(input.repoPath);
    if (!info.valid) {
      throw new ApiError(
        422,
        "REPO_REJECTED",
        `O repositório não pode ser usado: ${info.problems.map((problem) => PROBLEM_TEXT[problem]).join("; ")}.`,
        undefined,
        { problems: info.problems },
      );
    }
    if (info.currentBranch !== input.expectedBranch) {
      throw new ApiError(
        409,
        "BRANCH_CHANGED",
        `A branch atual do repositório agora é ${info.currentBranch ?? "(nenhuma)"}, e não ${input.expectedBranch}. Confira e envie de novo.`,
        undefined,
        { currentBranch: info.currentBranch },
      );
    }

    const runId = randomUUID();
    lock.acquire(runId);
    let active: ActiveRun;
    try {
      const git = this.gitFor(info.path);
      const refSnapshot = await git.snapshotRefs();
      let initialBranch: string;
      try {
        initialBranch = await git.createRunBranch(input.description, this.clock());
      } catch (error) {
        throw new ApiError(
          422,
          "REPO_REJECTED",
          `Não foi possível criar a branch da execução: ${errorText(error)}`,
          undefined,
          { problems: [] },
        );
      }
      const pipeline = structuredClone(input.pipeline);
      const run: Run = {
        schemaVersion: 1,
        id: runId,
        pipeline,
        repoPath: info.path,
        description: input.description.trim(),
        sourceBranch: input.expectedBranch,
        refSnapshot,
        initialBranch,
        createdBranches: [initialBranch],
        finalBranch: null,
        status: "running",
        startedAt: this.now(),
        finishedAt: null,
        steps: pipeline.steps.map((step) => newStepRun(step.id)),
      };
      await this.deps.runStore.save(run);
      active = { run, git, busy: false };
    } catch (error) {
      lock.release(runId);
      throw error;
    }

    this.active = active;
    this.emitUpdated(active);
    try {
      await this.deps.settingsStore.addRecentRepo(info.path);
      await this.deps.settingsStore.setLastPipelineId(input.pipeline.id);
    } catch (error) {
      console.warn("[executor] não foi possível atualizar settings.json:", errorText(error));
    }

    const snapshot = structuredClone(active.run);
    this.schedule(active, () => this.executeFrom(active, 0));
    return snapshot;
  }

  /** Resposta do usuário a um passo em `awaiting_input` (FR-009): nova invocação na mesma sessão. */
  async reply(runId: string, text: string): Promise<void> {
    const active = await this.requireActive(runId);
    const index = this.awaitingIndex(active);
    const { run } = active;
    const stepRun = run.steps[index]!;
    const step = run.pipeline.steps[index]!;

    stepRun.replies.push({ at: this.now(), text });
    stepRun.status = transitionStep(stepRun.status, "reply", { interactive: step.interactive });
    run.status = transitionRun(run.status, stepRun.status, { isLastStep: this.isLast(active, index) });
    const prior = stepRun.invocations.at(-1)?.sessionCostUsd ?? null;

    await this.appendOutput(active, index, [{ kind: "user_reply", text }]);
    await this.persist(active);
    this.schedule(active, async () => {
      const outcome = await this.invoke(active, index, text, true, prior);
      const status = await this.afterInvocation(active, index, outcome);
      if (status === "completed") await this.executeFrom(active, index + 1);
    });
  }

  /** Conclui o passo em `awaiting_input` (FR-009a): verifica as refs, commita e segue. */
  async advance(runId: string): Promise<void> {
    const active = await this.requireActive(runId);
    const index = this.awaitingIndex(active);
    const step = active.run.pipeline.steps[index]!;
    const stepRun = active.run.steps[index]!;
    active.busy = true;
    try {
      const verify = await this.verify(active, index);
      if (verify.violations.length > 0) {
        await this.recordError(active, index, violationMessage(verify));
        await this.applyStepEvent(active, index, "ref_violation");
        return;
      }
      stepRun.commitSha = await active.git.commitAll(`orchestrator: ${step.name} concluído`, active.run.id);
      const status = await this.applyStepEvent(active, index, "advance");
      if (status === "completed" && !this.isLast(active, index)) {
        this.schedule(active, () => this.executeFrom(active, index + 1));
      }
    } catch (error) {
      await this.crash(active, error);
      throw error;
    } finally {
      active.busy = false;
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** Roda os passos a partir de `index` até uma pausa interativa ou um estado terminal. */
  private async executeFrom(active: ActiveRun, index: number): Promise<void> {
    for (let i = index; i < active.run.steps.length; i++) {
      if (this.active !== active) return;
      const status = await this.executeStep(active, i);
      if (status !== "completed") return;
    }
  }

  private async executeStep(active: ActiveRun, index: number): Promise<StepStatus> {
    const { run } = active;
    const step = run.pipeline.steps[index]!;
    const stepRun = run.steps[index]!;

    stepRun.status = transitionStep(stepRun.status, "start", { interactive: step.interactive });
    run.status = transitionRun(run.status, stepRun.status, { isLastStep: this.isLast(active, index) });
    stepRun.startedAt = this.now();
    stepRun.sessionId = randomUUID();
    await this.persist(active);

    if (!(await this.commandExists(run.repoPath, step.command))) {
      const name = step.command.trim().split(/\s/, 1)[0] ?? step.command;
      return this.afterInvocation(active, index, {
        kind: "error",
        message:
          `O comando ${name} não existe no repositório (procurei em .claude/skills/<nome>/SKILL.md e ` +
          `.claude/commands/<nome>.md). Instale o Spec Kit no repositório ou corrija o comando do passo.`,
        usage: null,
        sessionCostUsd: null,
        durationMs: 0,
      });
    }

    // Só o 1º passo recebe a descrição da feature (FR-006).
    const prompt = index === 0 ? `${step.command} ${run.description}` : step.command;
    await this.appendOutput(active, index, [{ kind: "system", text: `Entrada: ${prompt}` }]);
    const outcome = await this.invoke(active, index, prompt, false, 0);
    return this.afterInvocation(active, index, outcome);
  }

  /** Uma chamada ao agente; registra a `Invocation` e soma duração e consumo do passo. */
  private async invoke(
    active: ActiveRun,
    index: number,
    prompt: string,
    resume: boolean,
    priorSessionCostUsd: number | null,
  ): Promise<AgentOutcome> {
    const { run } = active;
    const step = run.pipeline.steps[index]!;
    const stepRun = run.steps[index]!;
    const startedAt = this.now();
    const controller = new AbortController();

    let outputChain: Promise<void> = Promise.resolve();
    let outputError: unknown = null;
    const outcome = await this.deps.agentRunner.run({
      cwd: run.repoPath,
      prompt,
      model: step.model,
      sessionId: stepRun.sessionId!,
      resume,
      interactive: step.interactive,
      priorSessionCostUsd,
      signal: controller.signal,
      onOutput: (entry) => {
        outputChain = outputChain
          .then(() => this.appendOutput(active, index, [entry]))
          .catch((error: unknown) => {
            outputError ??= error;
          });
      },
    });
    await outputChain;
    if (outputError !== null) throw outputError;

    const invocation: Invocation = {
      prompt,
      startedAt,
      finishedAt: this.now(),
      durationMs: outcome.durationMs,
      outcome: outcome.kind,
      usage: outcome.usage,
      sessionCostUsd: outcome.sessionCostUsd,
    };
    stepRun.invocations.push(invocation);
    const totals = computeRunTotals({ steps: stepRun.invocations });
    stepRun.durationMs = totals.durationMs;
    stepRun.usage = totals.usage;
    return outcome;
  }

  /** Saída de `running`: verificação de refs sempre, depois commit conforme o resultado. */
  private async afterInvocation(active: ActiveRun, index: number, outcome: AgentOutcome): Promise<StepStatus> {
    const { run } = active;
    const step = run.pipeline.steps[index]!;
    const stepRun = run.steps[index]!;
    const verify = await this.verify(active, index);

    if (outcome.kind === "interrupted") {
      // Interrupção pelo usuário e limite de tempo chegam em US3; o passo fica `interrupted`.
      stepRun.interruptReason = "user";
      if (verify.violations.length > 0) stepRun.errorMessage = violationMessage(verify);
      else stepRun.commitSha = await active.git.commitAll(`WIP: passo ${step.name} interrompido`, run.id);
      return this.applyStepEvent(active, index, "interrupt");
    }
    if (verify.violations.length > 0) {
      await this.recordError(active, index, violationMessage(verify));
      return this.applyStepEvent(active, index, "ref_violation");
    }
    if (outcome.kind === "error") {
      await this.recordError(active, index, outcome.message);
      stepRun.commitSha = await active.git.commitAll(`WIP: passo ${step.name} com erro`, run.id);
      return this.applyStepEvent(active, index, "agent_error");
    }
    if (!step.interactive) {
      stepRun.commitSha = await active.git.commitAll(`orchestrator: ${step.name} concluído`, run.id);
    }
    return this.applyStepEvent(active, index, "agent_success");
  }

  /** Aplica o evento ao passo e ao run; grava e emite, ou encerra se o run ficou terminal. */
  private async applyStepEvent(active: ActiveRun, index: number, event: StepEvent): Promise<StepStatus> {
    const { run } = active;
    const stepRun = run.steps[index]!;
    const step = run.pipeline.steps[index]!;
    stepRun.status = transitionStep(stepRun.status, event, { interactive: step.interactive });
    if (TERMINAL_STEP.has(stepRun.status)) stepRun.finishedAt = this.now();
    run.status = transitionRun(run.status, stepRun.status, { isLastStep: this.isLast(active, index) });
    if (TERMINAL_RUN.has(run.status)) await this.finish(active);
    else await this.persist(active);
    return stepRun.status;
  }

  private async verify(active: ActiveRun, index: number): Promise<VerifyResult> {
    const { run } = active;
    const result = await active.git.verifyAfterStep(run.refSnapshot);
    for (const branch of result.newBranches) {
      if (!run.createdBranches.includes(branch)) run.createdBranches.push(branch);
    }
    run.steps[index]!.branchAtEnd = result.activeBranch;
    return result;
  }

  /** Estado terminal: `finishedAt`, `finalBranch`, `run.finished` e liberação da trava (FR-012/FR-017). */
  private async finish(active: ActiveRun): Promise<void> {
    const { run } = active;
    run.finishedAt = this.now();
    try {
      run.finalBranch = await active.git.currentBranch();
    } catch (error) {
      console.warn("[executor] não foi possível ler a branch final:", errorText(error));
    }
    try {
      await this.deps.runStore.save(run);
    } finally {
      if (this.active === active) this.active = null;
      this.deps.lock.release(run.id);
      this.deps.eventHub.broadcast({ type: "run.finished", run: structuredClone(run) });
    }
  }

  private async persist(active: ActiveRun): Promise<void> {
    await this.deps.runStore.save(active.run);
    this.emitUpdated(active);
  }

  private emitUpdated(active: ActiveRun): void {
    this.deps.eventHub.broadcast({ type: "run.updated", run: structuredClone(active.run) });
  }

  private async appendOutput(active: ActiveRun, index: number, entries: Array<Omit<OutputEntry, "seq" | "at">>) {
    const { runStore } = this.deps;
    const runId = active.run.id;
    const full: OutputEntry[] = [];
    for (const entry of entries) {
      full.push({ seq: await runStore.nextSeq(runId, index), at: this.now(), kind: entry.kind, text: entry.text });
    }
    // Grava no `.jsonl` antes de enviar: o que o cliente recebe sempre pode ser rebuscado pela API.
    await runStore.appendOutput(runId, index, full);
    for (const entry of full) this.deps.eventHub.pushOutput(runId, index, entry);
  }

  /** `errorMessage` do passo e a mesma mensagem como entrada `error` da saída (FR-015). */
  private async recordError(active: ActiveRun, index: number, message: string): Promise<void> {
    active.run.steps[index]!.errorMessage = message;
    await this.appendOutput(active, index, [{ kind: "error", text: message }]);
  }

  /** Encadeia trabalho em segundo plano; uma falha inesperada marca o run como `failed`. */
  private schedule(active: ActiveRun, task: () => Promise<void>): void {
    this.background = this.background.then(task).catch((error: unknown) => this.crash(active, error));
  }

  /** Falha inesperada do orquestrador (git, disco): o passo atual e o run viram `failed`. */
  private async crash(active: ActiveRun, error: unknown): Promise<void> {
    console.error("[executor] falha inesperada:", error);
    if (this.active !== active) return;
    const { run } = active;
    const current = run.steps.find((step) => step.status === "running" || step.status === "awaiting_input");
    if (current) {
      current.status = "failed";
      current.finishedAt = this.now();
      current.errorMessage = `Erro interno do orquestrador: ${errorText(error)}`;
      try {
        await this.appendOutput(active, run.steps.indexOf(current), [{ kind: "error", text: current.errorMessage }]);
      } catch (outputError) {
        console.error("[executor] não foi possível gravar a saída de erro:", outputError);
      }
    }
    run.status = "failed";
    try {
      await this.finish(active);
    } catch (finishError) {
      console.error("[executor] não foi possível gravar o run após a falha:", finishError);
    }
  }

  /** O run ativo com esse id; `404` se não existir, `409 INVALID_STATE` se não estiver em andamento. */
  private async requireActive(runId: string): Promise<ActiveRun> {
    if (this.active?.run.id === runId) return this.active;
    await this.deps.runStore.get(runId); // 404 NOT_FOUND se não existir
    throw new ApiError(409, "INVALID_STATE", "Esta execução não está em andamento.");
  }

  private awaitingIndex(active: ActiveRun): number {
    const index = active.run.steps.findIndex((step) => step.status === "awaiting_input");
    if (index < 0 || active.busy) {
      throw new ApiError(409, "INVALID_STATE", "O passo atual não está aguardando resposta.");
    }
    return index;
  }

  private isLast(active: ActiveRun, index: number): boolean {
    return index === active.run.steps.length - 1;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function newStepRun(stepId: string): StepRun {
  return {
    stepId,
    status: "waiting",
    sessionId: null,
    replies: [],
    invocations: [],
    errorMessage: null,
    interruptReason: null,
    commitSha: null,
    branchAtEnd: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    usage: null,
  };
}

function violationMessage(verify: VerifyResult): string {
  return `O passo alterou referências protegidas do Git, e nada foi commitado: ${verify.violations.join("; ")}.`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
