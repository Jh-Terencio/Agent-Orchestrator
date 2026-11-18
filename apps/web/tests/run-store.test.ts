import { describe, expect, it } from "vitest";
import { createDefaultPipeline, type OutputEntry, type Run } from "@orchestrator/shared";
import { initialRunState, runReducer, type RunState } from "../src/state/run-store";

const NOW = "2026-11-17T12:00:00.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
  const pipeline = createDefaultPipeline(NOW);
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    pipeline,
    repoPath: "C:/repos/alvo",
    description: "Adicionar login",
    sourceBranch: "main",
    refSnapshot: [],
    initialBranch: "orchestrator/20261117-120000-adicionar-login",
    createdBranches: ["orchestrator/20261117-120000-adicionar-login"],
    finalBranch: null,
    yolo: false,
    permissionRules: [],
    status: "running",
    startedAt: NOW,
    finishedAt: null,
    steps: pipeline.steps.map((step, index) => ({
      stepId: step.id,
      status: index === 0 ? "running" : "waiting",
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
    })),
    ...overrides,
  };
}

function entry(seq: number): OutputEntry {
  return { seq, at: NOW, kind: "text", text: `t${seq}` };
}

describe("runReducer", () => {
  it("hello define o run ativo", () => {
    const run = makeRun();
    const state = runReducer(initialRunState, { type: "hello", activeRun: run });
    expect(state.run).toEqual(run);
    expect(state.outputs).toEqual({});
  });

  it("hello com activeRun null limpa o estado", () => {
    const withRun = runReducer(initialRunState, { type: "hello", activeRun: makeRun() });
    expect(runReducer(withRun, { type: "hello", activeRun: null }).run).toBeNull();
  });

  it("hello do mesmo run (reconexão) mantém a saída já recebida", () => {
    let state = runReducer(initialRunState, { type: "hello", activeRun: makeRun() });
    state = runReducer(state, { type: "step.output", runId: makeRun().id, stepIndex: 0, entries: [entry(1)] });
    state = runReducer(state, { type: "hello", activeRun: makeRun() });
    expect(state.outputs[0]).toEqual([entry(1)]);
  });

  it("run.updated substitui o snapshot", () => {
    let state = runReducer(initialRunState, { type: "hello", activeRun: makeRun() });
    const updated = makeRun({ status: "awaiting_input" });
    state = runReducer(state, { type: "run.updated", run: updated });
    expect(state.run).toEqual(updated);
  });

  it("run.finished marca terminal", () => {
    let state = runReducer(initialRunState, { type: "hello", activeRun: makeRun() });
    state = runReducer(state, { type: "run.finished", run: makeRun({ status: "completed", finishedAt: NOW }) });
    expect(state.run?.status).toBe("completed");
    expect(state.finished).toBe(true);
  });

  it("step.output acrescenta entradas por passo e ignora seq já visto", () => {
    let state: RunState = runReducer(initialRunState, { type: "hello", activeRun: makeRun() });
    const runId = makeRun().id;
    state = runReducer(state, { type: "step.output", runId, stepIndex: 0, entries: [entry(1), entry(2)] });
    state = runReducer(state, { type: "step.output", runId, stepIndex: 0, entries: [entry(2), entry(3)] });
    state = runReducer(state, { type: "step.output", runId, stepIndex: 1, entries: [entry(1)] });
    expect(state.outputs[0]?.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(state.outputs[1]?.map((item) => item.seq)).toEqual([1]);
    expect(state.lastSeq).toEqual({ 0: 3, 1: 1 });
  });

  it("step.output de outro run é ignorado", () => {
    let state = runReducer(initialRunState, { type: "hello", activeRun: makeRun() });
    state = runReducer(state, {
      type: "step.output",
      runId: "22222222-2222-4222-8222-222222222222",
      stepIndex: 0,
      entries: [entry(1)],
    });
    expect(state.outputs).toEqual({});
  });

  it("connection atualiza o status da conexão", () => {
    const state = runReducer(initialRunState, { type: "connection", status: "reconnecting" });
    expect(state.connection).toBe("reconnecting");
  });
});
