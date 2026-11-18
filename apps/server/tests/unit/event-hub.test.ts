import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPipeline, type OutputEntry, type Run, type ServerEvent } from "@orchestrator/shared";
import { EventHub, OUTPUT_BATCH_MS } from "../../src/ws/event-hub.js";

const NOW = "2026-11-17T12:00:00.000Z";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

function makeRun(): Run {
  const pipeline = createDefaultPipeline(NOW);
  return {
    schemaVersion: 1,
    id: RUN_ID,
    pipeline,
    repoPath: "/repo",
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
    steps: pipeline.steps.map((step) => ({
      stepId: step.id,
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
    })),
  };
}

const entry = (seq: number, text = `linha ${seq}`): OutputEntry => ({ seq, at: NOW, kind: "text", text });

let server: Server;
let hub: EventHub;
let sent: ServerEvent[];

beforeEach(() => {
  vi.useFakeTimers();
  server = createServer();
  hub = new EventHub(server, { isAllowed: () => true, getActiveRun: () => null });
  sent = [];
  // Captura o que seria enviado aos clientes, sem abrir sockets.
  vi.spyOn(hub as unknown as { send: (event: ServerEvent) => void }, "send").mockImplementation((event) => {
    sent.push(event);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await hub.close();
});

describe("EventHub: batching de saída (SC-003)", () => {
  it("agrupa as entradas e emite um único step.output por passo a cada ≤ 250 ms", () => {
    expect(OUTPUT_BATCH_MS).toBeLessThanOrEqual(250);
    hub.pushOutput(RUN_ID, 0, entry(1));
    hub.pushOutput(RUN_ID, 0, entry(2));
    hub.pushOutput(RUN_ID, 1, entry(1));
    hub.pushOutput(RUN_ID, 0, entry(3));
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(OUTPUT_BATCH_MS);
    expect(sent).toEqual([
      { type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [entry(1), entry(2), entry(3)] },
      { type: "step.output", runId: RUN_ID, stepIndex: 1, entries: [entry(1)] },
    ]);

    hub.pushOutput(RUN_ID, 0, entry(4));
    vi.advanceTimersByTime(OUTPUT_BATCH_MS - 1);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [entry(4)] });
  });

  it("flush() emite imediatamente o pendente e cancela o timer", () => {
    hub.pushOutput(RUN_ID, 2, entry(1));
    hub.flush();
    expect(sent).toEqual([{ type: "step.output", runId: RUN_ID, stepIndex: 2, entries: [entry(1)] }]);
    vi.advanceTimersByTime(OUTPUT_BATCH_MS * 4);
    expect(sent).toHaveLength(1);
    hub.flush();
    expect(sent).toHaveLength(1);
  });

  it("run.updated depois de saídas pendentes é precedido pelo flush dessas saídas", () => {
    const run = makeRun();
    hub.pushOutput(RUN_ID, 0, entry(1));
    hub.broadcast({ type: "run.updated", run });
    hub.pushOutput(RUN_ID, 0, entry(2));
    hub.broadcast({ type: "run.finished", run });
    expect(sent.map((event) => event.type)).toEqual(["step.output", "run.updated", "step.output", "run.finished"]);
    expect(sent[0]).toMatchObject({ entries: [entry(1)] });
    expect(sent[2]).toMatchObject({ entries: [entry(2)] });
  });
});
