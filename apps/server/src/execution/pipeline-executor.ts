import { randomUUID } from "node:crypto";
import {
  computeRunTotals,
  DEFAULT_TIMEOUT_MINUTES,
  deriveRule,
  matchesRule,
  PipelineSchema,
  summarizeToolInput,
  type InterruptReason,
  type Invocation,
  type OutputEntry,
  type PermissionDecision,
  type PermissionRequest,
  type Pipeline,
  type RepoInfo,
  type RepoProblem,
  type Run,
  type ServerEvent,
  type StepRun,
  type StepStatus,
} from "@orchestrator/shared";
import type { AgentOutcome, AgentRunner, PermissionChannel, RelayDecision } from "../agent/agent-runner.js";
import { commandExists as defaultCommandExists } from "../agent/command-lookup.js";
import { GitService, type VerifyResult } from "../git/git-service.js";
import { ApiError, toApiIssues } from "../http/errors.js";
import type { RunStore } from "../storage/run-store.js";
import type { SettingsStore } from "../storage/settings-store.js";
import { createPausableTimer, type PausableTimer } from "./pausable-timer.js";
import type { PermissionBroker, PermissionCall } from "./permission-broker.js";
import { runAlreadyActive, type RunLock } from "./run-lock.js";
import { transitionRun, transitionStep, type StepEvent } from "./state-machine.js";

export const DENIED_BY_USER_MESSAGE = "Negado pelo usuário no orquestrador.";
export const INTERRUPTED_MESSAGE = "Execução interrompida.";
export const CLI_GAVE_UP_MESSAGE = "A CLI desistiu de esperar pela decisão";

export interface PipelineExecutorDeps {
  agentRunner: AgentRunner;
  /** Canais de permissão por invocação (US6, research R13). */
  permissionBroker: PermissionBroker;
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
  /** Modo Yolo (FR-027): sem pedidos de permissão. */
  yolo: boolean;
}

interface ActiveRun {
  run: Run;
  git: GitService;
  /** `true` enquanto um `advance` ou uma interrupção em pausa verifica e commita. */
  busy: boolean;
  /** Controller da invocação em andamento (um por chamada ao agente; research R4). */
  controller: AbortController | null;
  /** Interrupção pedida quando não havia invocação viva: aplicada no próximo ponto seguro. */
  pendingAbort: InterruptReason | null;
  /** Motivo do abort da última invocação (`signal.reason`). */
  lastAbortReason: InterruptReason | null;
  /** Limite de tempo da invocação em andamento, pausado em `awaiting_permission` (FR-032). */
  timer: PausableTimer | null;
  /** Respostas à CLI ainda pendentes, por id do `PermissionRequest`. */
  permissionWaiters: Map<string, (decision: RelayDecision) => void>;
  /** Gravações do `run.json` em fila: pedidos de permissão podem chegar em paralelo. */
  saveQueue: Promise<void>;
  /** Escritas da saída em fila, para o `seq` seguir a ordem de chegada. */
  outputQueue: Promise<void>;
}

const TERMINAL_RUN = new Set<Run["status"]>(["completed", "failed", "interrupted"]);
const TERMINAL_STEP = new Set<StepStatus>(["completed", "failed", "interrupted"]);
const ACTIVE_STEP = new Set<StepStatus>(["running", "awaiting_input", "awaiting_permission"]);
const INTERRUPT_REASONS = new Set<string>(["user", "timeout", "server_shutdown"]);
const REASON_EVENT: Record<InterruptReason, StepEvent> = {
  user: "interrupt",
  timeout: "timeout",
  server_shutdown: "shutdown",
};

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

    // Revalida a esteira antes de executar (FR-024): nada é criado se ela for inválida.
    const validated = PipelineSchema.safeParse(input.pipeline);
    if (!validated.success) {
      throw new ApiError(
        422,
        "PIPELINE_INVALID",
        "A esteira é inválida; corrija-a no editor de esteiras antes de executar",
        toApiIssues(validated.error),
      );
    }

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
        yolo: input.yolo,
        permissionRules: [],
        status: "running",
        startedAt: this.now(),
        finishedAt: null,
        steps: pipeline.steps.map((step) => newStepRun(step.id)),
      };
      await this.deps.runStore.save(run);
      active = {
        run,
        git,
        busy: false,
        controller: null,
        pendingAbort: null,
        lastAbortReason: null,
        timer: null,
        permissionWaiters: new Map(),
        saveQueue: Promise.resolve(),
        outputQueue: Promise.resolve(),
      };
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

  /**
   * Interrompe a execução (FR-018/FR-019): em `running`, aborta a invocação com `"user"` (o agente é
   * encerrado e o passo fica `interrupted` em segundo plano); em `awaiting_input`, transita direto
   * para `interrupted` com commit WIP. Nada é reexecutado depois.
   */
  async interrupt(runId: string): Promise<void> {
    const active = await this.requireActive(runId);
    await this.requestInterrupt(active, "user");
  }

  /**
   * Encerramento do servidor (plan, "Shutdown"): interrompe o run ativo com `"server_shutdown"`,
   * aguarda o commit WIP e a gravação do `run.json` e só então resolve.
   */
  async shutdown(): Promise<void> {
    for (let attempt = 0; this.active !== null && attempt < 50; attempt++) {
      const active = this.active;
      try {
        await this.requestInterrupt(active, "server_shutdown");
      } catch (error) {
        console.error("[executor] falha ao interromper no encerramento:", error);
      }
      await this.whenIdle();
      // Um `advance` em curso ainda pode agendar o próximo passo: tenta de novo.
      if (this.active === active) await new Promise((resolve) => setImmediate(resolve));
    }
    await this.whenIdle();
  }

  /**
   * Decisão do usuário sobre um pedido de permissão (FR-029): responde à CLI e, sem outros pedidos
   * pendentes, o passo volta a `running` e o limite de tempo é retomado (FR-032).
   * `404` sem execução ou pedido; `409 INVALID_STATE` se o pedido já foi decidido.
   */
  async decidePermission(runId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    const active = await this.requireActive(runId);
    const { run } = active;
    const index = run.steps.findIndex((step) => step.permissionRequests.some((request) => request.id === requestId));
    if (index < 0) throw new ApiError(404, "NOT_FOUND", "Pedido de permissão não encontrado");
    const stepRun = run.steps[index]!;
    const request = stepRun.permissionRequests.find((item) => item.id === requestId)!;
    const waiter = active.permissionWaiters.get(requestId);
    if (request.status !== "pending" || waiter === undefined) {
      throw new ApiError(409, "INVALID_STATE", "Este pedido de permissão já foi decidido.");
    }

    // Tudo síncrono até aqui: um segundo clique já encontra o pedido decidido.
    active.permissionWaiters.delete(requestId);
    request.decidedAt = this.now();
    let reply: RelayDecision;
    let text: string;
    if (decision === "deny") {
      request.status = "denied";
      reply = { behavior: "deny", message: DENIED_BY_USER_MESSAGE };
      text = `Negado: ${request.summary}`;
    } else if (decision === "allow_always") {
      const rule = deriveRule(request.toolName, request.input);
      request.status = "allowed_always";
      request.rule = rule;
      if (!run.permissionRules.includes(rule)) run.permissionRules.push(rule);
      reply = { behavior: "allow", updatedInput: request.input };
      text = `Permitido sempre: ${rule}`;
    } else {
      request.status = "allowed_once";
      reply = { behavior: "allow", updatedInput: request.input };
      text = `Permitido uma vez: ${request.summary}`;
    }
    const resume = stepRun.status === "awaiting_permission" && !hasPending(stepRun);
    if (resume) this.applyStepStatus(active, index, "permission_decision");

    await this.appendOutput(active, index, [{ kind: "system", text }]);
    if (resume) active.timer?.resume();
    waiter(reply);
    await this.persist(active);
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Pedido de permissão vindo do relay (research R13). Casa com uma regra de "permitir sempre" → `allow`
   * na hora; senão registra o pedido, pausa o passo e o limite de tempo e espera `decidePermission`.
   * A parte síncrona registra o pedido antes de qualquer `await`, para a ordem dos pedidos ser a de chegada.
   */
  private onPermissionRequest(
    active: ActiveRun,
    index: number,
    controller: AbortController,
    call: PermissionCall,
  ): Promise<RelayDecision> {
    const { run } = active;
    const stepRun = run.steps[index]!;
    if (this.active !== active || controller.signal.aborted || active.pendingAbort !== null) {
      return Promise.resolve({ behavior: "deny", message: INTERRUPTED_MESSAGE });
    }
    const request: PermissionRequest = {
      id: randomUUID(),
      toolUseId: call.toolUseId,
      toolName: call.toolName,
      input: call.input,
      summary: `${call.toolName}: ${summarizeToolInput(call.input)}`,
      status: "pending",
      rule: null,
      requestedAt: this.now(),
      decidedAt: null,
    };
    stepRun.permissionRequests.push(request);

    const rule = run.permissionRules.find((candidate) => matchesRule(candidate, call.toolName, call.input));
    if (rule !== undefined) {
      request.status = "auto_allowed";
      request.rule = rule;
      request.decidedAt = request.requestedAt;
      return (async () => {
        await this.appendOutput(active, index, [
          { kind: "system", text: `Permitido pela regra ${rule}: ${request.summary}` },
        ]);
        await this.persist(active);
        return { behavior: "allow", updatedInput: call.input } satisfies RelayDecision;
      })();
    }

    const decision = new Promise<RelayDecision>((resolve) => active.permissionWaiters.set(request.id, resolve));
    this.applyStepStatus(active, index, "permission_request");
    active.timer?.pause();
    void (async () => {
      await this.appendOutput(active, index, [{ kind: "system", text: `Permissão pedida: ${request.summary}` }]);
      await this.persist(active);
    })().catch((error: unknown) => console.error("[executor] não foi possível registrar o pedido:", error));
    return decision;
  }

  /**
   * Pedidos ainda pendentes viram `cancelled` e a CLI recebe `deny` (interrupção, encerramento ou fim
   * da invocação). Não grava: quem chama persiste depois.
   */
  private async cancelPendingPermissions(active: ActiveRun, index: number, reason: string): Promise<void> {
    const stepRun = active.run.steps[index];
    if (!stepRun) return;
    const texts: string[] = [];
    for (const request of stepRun.permissionRequests) {
      if (request.status !== "pending") continue;
      request.status = "cancelled";
      request.decidedAt = this.now();
      texts.push(`Pedido de permissão cancelado (${reason}): ${request.summary}`);
      const waiter = active.permissionWaiters.get(request.id);
      active.permissionWaiters.delete(request.id);
      waiter?.({ behavior: "deny", message: `${reason}.` });
    }
    if (texts.length > 0) await this.appendOutput(active, index, texts.map((text) => ({ kind: "system", text })));
  }

  /** Transição sem gravar (a gravação vem logo depois, na mesma operação). */
  private applyStepStatus(active: ActiveRun, index: number, event: StepEvent): void {
    const { run } = active;
    const stepRun = run.steps[index]!;
    const step = run.pipeline.steps[index]!;
    stepRun.status = transitionStep(stepRun.status, event, { interactive: step.interactive });
    run.status = transitionRun(run.status, stepRun.status, { isLastStep: this.isLast(active, index) });
  }

  private async requestInterrupt(active: ActiveRun, reason: InterruptReason): Promise<void> {
    if (active.run.status === "awaiting_input" && !active.busy) {
      await this.interruptAwaiting(active, reason);
      return;
    }
    // `server_shutdown` prevalece sobre um pedido anterior do usuário. Definido antes de cancelar os
    // pedidos, para um pedido novo que chegue durante o cancelamento já ser negado.
    if (active.pendingAbort === null || reason === "server_shutdown") active.pendingAbort = reason;
    const waitingIndex = active.run.steps.findIndex((step) => step.status === "awaiting_permission");
    if (waitingIndex >= 0) {
      // A CLI recebe `deny` antes de o processo ser encerrado (Review Focus 2).
      await this.cancelPendingPermissions(active, waitingIndex, INTERRUPTED_MESSAGE.slice(0, -1));
    }
    active.controller?.abort(reason);
  }

  /** Interrupção de um passo em `awaiting_input` (sem processo vivo): verificação de refs e commit WIP. */
  private async interruptAwaiting(active: ActiveRun, reason: InterruptReason): Promise<StepStatus> {
    const index = active.run.steps.findIndex((step) => step.status === "awaiting_input");
    if (index < 0) throw new ApiError(409, "INVALID_STATE", "O passo atual não está aguardando resposta.");
    active.busy = true;
    try {
      await this.closeInterrupted(active, index, reason);
      return await this.applyStepEvent(active, index, REASON_EVENT[reason]);
    } catch (error) {
      await this.crash(active, error);
      throw error;
    } finally {
      active.busy = false;
    }
  }

  /** Passo interrompido: motivo, e commit WIP só se a verificação de refs passar (FR-011a). */
  private async closeInterrupted(active: ActiveRun, index: number, reason: InterruptReason): Promise<void> {
    const { run } = active;
    const step = run.pipeline.steps[index]!;
    const stepRun = run.steps[index]!;
    const verify = await this.verify(active, index);
    stepRun.interruptReason = reason;
    if (verify.violations.length > 0) await this.recordError(active, index, violationMessage(verify));
    else stepRun.commitSha = await active.git.commitAll(`WIP: passo ${step.name} interrompido`, run.id);
  }

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

    if (active.pendingAbort !== null) {
      return this.afterInvocation(active, index, { kind: "interrupted", usage: null, sessionCostUsd: null, durationMs: 0 });
    }

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
    active.controller = controller;
    active.lastAbortReason = null;
    if (active.pendingAbort !== null) controller.abort(active.pendingAbort);
    // setTimeout (e não AbortSignal.timeout) para os fake timers controlarem o limite (research R4).
    // O timer é por invocação: a pausa em awaiting_input não conta e cada resposta recebe o limite inteiro.
    // Ele é pausado enquanto houver pedidos de permissão pendentes (FR-032).
    const timeoutMs = (step.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
    const timer = createPausableTimer(timeoutMs, () => controller.abort("timeout"));
    active.timer = timer;

    // Fora do Modo Yolo, um canal de permissão por invocação (research R13).
    const { permissionBroker } = this.deps;
    const channel: PermissionChannel | null = run.yolo
      ? null
      : permissionBroker.openChannel((call) => this.onPermissionRequest(active, index, controller, call));

    let outputChain: Promise<void> = Promise.resolve();
    let outputError: unknown = null;
    let outcome: AgentOutcome;
    try {
      outcome = await this.deps.agentRunner.run({
        cwd: run.repoPath,
        prompt,
        model: step.model,
        sessionId: stepRun.sessionId!,
        resume,
        interactive: step.interactive,
        priorSessionCostUsd,
        permissionChannel: channel,
        signal: controller.signal,
        onOutput: (entry) => {
          outputChain = outputChain
            .then(() => this.appendOutput(active, index, [entry]))
            .catch((error: unknown) => {
              outputError ??= error;
            });
        },
      });
    } finally {
      timer.clear();
      if (active.timer === timer) active.timer = null;
      if (channel !== null) permissionBroker.closeChannel(channel.token);
      if (active.controller === controller) active.controller = null;
    }
    if (controller.signal.aborted) active.lastAbortReason = toInterruptReason(controller.signal.reason);
    await outputChain;
    if (outputError !== null) throw outputError;
    await this.settlePermissionsAfterInvocation(active, index, outcome);

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

  /**
   * O processo do agente terminou: nenhum pedido pode continuar pendente. Os que restarem (a CLI
   * desistiu de esperar ou terminou sem esperar) viram `cancelled`. Se o passo ainda estiver em
   * `awaiting_permission`, ele volta a `running` para seguir o caminho normal de `afterInvocation`,
   * exceto numa interrupção do usuário ou do encerramento, que vale também em `awaiting_permission`.
   */
  private async settlePermissionsAfterInvocation(active: ActiveRun, index: number, outcome: AgentOutcome) {
    const stepRun = active.run.steps[index]!;
    if (hasPending(stepRun)) {
      const reason = outcome.kind === "interrupted" ? INTERRUPTED_MESSAGE.slice(0, -1) : CLI_GAVE_UP_MESSAGE;
      await this.cancelPendingPermissions(active, index, reason);
    }
    if (stepRun.status !== "awaiting_permission") return;
    const reason = active.lastAbortReason ?? active.pendingAbort;
    const interruptsDirectly = outcome.kind === "interrupted" && reason !== null && reason !== "timeout";
    if (!interruptsDirectly) this.applyStepStatus(active, index, "permission_decision");
  }

  /** Saída de `running`: verificação de refs sempre, depois commit conforme o resultado. */
  private async afterInvocation(active: ActiveRun, index: number, outcome: AgentOutcome): Promise<StepStatus> {
    const { run } = active;
    const step = run.pipeline.steps[index]!;
    const stepRun = run.steps[index]!;

    if (outcome.kind === "interrupted") {
      // Interromper, limite de tempo ou encerramento: o motivo vem do `signal.reason` (research R4).
      const reason = active.lastAbortReason ?? active.pendingAbort ?? "user";
      await this.closeInterrupted(active, index, reason);
      return this.applyStepEvent(active, index, REASON_EVENT[reason]);
    }
    const verify = await this.verify(active, index);
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
    const status = await this.applyStepEvent(active, index, "agent_success");
    // Interrupção pedida enquanto o agente terminava: aplica-se à pausa recém-aberta.
    if (status === "awaiting_input" && active.pendingAbort !== null) {
      return this.interruptAwaiting(active, active.pendingAbort);
    }
    return status;
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
      await this.save(active);
    } finally {
      if (this.active === active) this.active = null;
      this.deps.lock.release(run.id);
      this.deps.eventHub.broadcast({ type: "run.finished", run: structuredClone(run) });
    }
  }

  private async persist(active: ActiveRun): Promise<void> {
    // Depois do estado terminal, `finish` já gravou e emitiu `run.finished`.
    if (this.active !== active) return;
    await this.save(active);
    if (this.active === active) this.emitUpdated(active);
  }

  /** Gravações do mesmo run em fila (o rename atômico não tolera duas escritas simultâneas). */
  private save(active: ActiveRun): Promise<void> {
    const task = active.saveQueue.then(() => this.deps.runStore.save(active.run));
    active.saveQueue = task.catch(() => undefined);
    return task;
  }

  private emitUpdated(active: ActiveRun): void {
    this.deps.eventHub.broadcast({ type: "run.updated", run: structuredClone(active.run) });
  }

  /** Escritas da saída em fila: o `seq` segue a ordem de chegada mesmo com pedidos de permissão em paralelo. */
  private appendOutput(
    active: ActiveRun,
    index: number,
    entries: Array<Omit<OutputEntry, "seq" | "at">>,
  ): Promise<void> {
    const task = active.outputQueue.then(() => this.writeOutput(active, index, entries));
    active.outputQueue = task.catch(() => undefined);
    return task;
  }

  private async writeOutput(active: ActiveRun, index: number, entries: Array<Omit<OutputEntry, "seq" | "at">>) {
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
    const current = run.steps.find((step) => ACTIVE_STEP.has(step.status));
    if (current) {
      for (const request of current.permissionRequests) {
        if (request.status !== "pending") continue;
        request.status = "cancelled";
        request.decidedAt = this.now();
        const waiter = active.permissionWaiters.get(request.id);
        active.permissionWaiters.delete(request.id);
        waiter?.({ behavior: "deny", message: "Erro interno do orquestrador; comando negado." });
      }
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
    permissionRequests: [],
  };
}

function hasPending(stepRun: StepRun): boolean {
  return stepRun.permissionRequests.some((request) => request.status === "pending");
}

function violationMessage(verify: VerifyResult): string {
  return `O passo alterou referências protegidas do Git, e nada foi commitado: ${verify.violations.join("; ")}.`;
}

function toInterruptReason(reason: unknown): InterruptReason {
  return typeof reason === "string" && INTERRUPT_REASONS.has(reason) ? (reason as InterruptReason) : "user";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
