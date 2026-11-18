import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPipeline, type OutputEntry, type Run, type ServerEvent } from "@orchestrator/shared";
import * as client from "../src/api/client";
import type { ConnectionStatus } from "../src/api/ws";
import { initialRunState, runReducer, RunStoreProvider, useRunStore } from "../src/state/run-store";

const ws = vi.hoisted(() => ({
  onEvent: null as ((event: ServerEvent) => void) | null,
  onStatus: null as ((status: ConnectionStatus) => void) | null,
}));

vi.mock("../src/api/ws", () => ({
  connectEvents: (onEvent: (event: ServerEvent) => void, onStatus: (status: ConnectionStatus) => void) => {
    ws.onEvent = onEvent;
    ws.onStatus = onStatus;
    return () => {};
  },
}));
vi.mock("../src/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api/client")>();
  return { ...original, getStepOutput: vi.fn() };
});

const api = vi.mocked(client);
const NOW = "2026-11-17T12:00:00.000Z";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PIPELINE = createDefaultPipeline(NOW);

function makeRun(statuses: Run["steps"][number]["status"][]): Run {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    pipeline: PIPELINE,
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
    steps: PIPELINE.steps.map((step, index) => ({
      stepId: step.id,
      status: statuses[index] ?? "waiting",
      sessionId: null,
      replies: [],
      invocations: [],
      errorMessage: null,
      interruptReason: null,
      commitSha: null,
      branchAtEnd: null,
      startedAt: statuses[index] && statuses[index] !== "waiting" ? NOW : null,
      finishedAt: null,
      durationMs: null,
      usage: null,
      permissionRequests: [],
    })),
  };
}

const entry = (seq: number, text = `linha ${seq}`): OutputEntry => ({ seq, at: NOW, kind: "text", text });

const wrapper = ({ children }: { children: ReactNode }) => createElement(RunStoreProvider, null, children);

function emit(event: ServerEvent): void {
  act(() => ws.onEvent!(event));
}

beforeEach(() => {
  vi.resetAllMocks();
  ws.onEvent = null;
  ws.onStatus = null;
});

describe("ressincronização após reconectar (contracts/websocket-events.md)", () => {
  it("após reconexão busca getStepOutput(runId, i, lastSeq[i]) para cada passo iniciado e não duplica entradas", async () => {
    api.getStepOutput.mockImplementation(async (_runId, index) =>
      index === 0 ? [entry(3), entry(4), entry(5)] : [entry(1, "plan 1")],
    );
    const { result } = renderHook(() => useRunStore(), { wrapper });

    act(() => ws.onStatus!("connected"));
    emit({ type: "hello", activeRun: makeRun(["running"]) });
    emit({ type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [entry(1), entry(2), entry(3)] });
    // A conexão inicial não ressincroniza.
    expect(api.getStepOutput).not.toHaveBeenCalled();

    act(() => ws.onStatus!("reconnecting"));
    act(() => ws.onStatus!("connected"));
    emit({ type: "hello", activeRun: makeRun(["completed", "running"]) });

    await waitFor(() => expect(result.current.state.outputs[1]).toHaveLength(1));
    expect(api.getStepOutput).toHaveBeenCalledTimes(2);
    expect(api.getStepOutput).toHaveBeenCalledWith(RUN_ID, 0, 3);
    expect(api.getStepOutput).toHaveBeenCalledWith(RUN_ID, 1, -1);
    await waitFor(() => expect(result.current.state.outputs[0]?.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]));
    expect(result.current.state.lastSeq).toEqual({ 0: 5, 1: 1 });
  });

  it("hello sem run ativo após reconectar não busca saída", async () => {
    renderHook(() => useRunStore(), { wrapper });
    act(() => ws.onStatus!("reconnecting"));
    act(() => ws.onStatus!("connected"));
    emit({ type: "hello", activeRun: null });
    await Promise.resolve();
    expect(api.getStepOutput).not.toHaveBeenCalled();
  });
});

describe("runReducer: mescla por seq", () => {
  it("entradas buscadas que chegam depois de entradas mais novas do WS não se perdem nem duplicam", () => {
    let state = runReducer(initialRunState, { type: "hello", activeRun: makeRun(["running"]) });
    state = runReducer(state, { type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [entry(4), entry(5)] });
    state = runReducer(state, {
      type: "outputs.fetched",
      runId: RUN_ID,
      stepIndex: 0,
      entries: [entry(1), entry(2), entry(3), entry(4)],
    });
    expect(state.outputs[0]?.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(state.lastSeq[0]).toBe(5);
  });
});
