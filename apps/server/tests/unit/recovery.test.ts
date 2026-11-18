import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultPipeline, type Run, type RunStatus, type StepRun } from "@orchestrator/shared";
import { recoverInterruptedRuns } from "../../src/execution/recovery.js";
import { RunStore } from "../../src/storage/run-store.js";

const NOW = "2026-11-17T12:00:00.000Z";
const PIPELINE = createDefaultPipeline(NOW);

let dataDir: string;
let runStore: RunStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "orchestrator-recovery-"));
  runStore = new RunStore(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function stepRun(index: number, overrides: Partial<StepRun> = {}): StepRun {
  return {
    stepId: PIPELINE.steps[index]!.id,
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
    ...overrides,
  };
}

function makeRun(id: string, status: RunStatus, steps: Partial<StepRun>[], finishedAt: string | null = null): Run {
  return {
    schemaVersion: 1,
    id,
    pipeline: PIPELINE,
    repoPath: "C:/repos/alvo",
    description: "Adicionar login",
    sourceBranch: "main",
    refSnapshot: [],
    initialBranch: "orchestrator/20261117-120000-adicionar-login",
    createdBranches: ["orchestrator/20261117-120000-adicionar-login"],
    finalBranch: null,
    status,
    startedAt: NOW,
    finishedAt,
    steps: PIPELINE.steps.map((_, index) => stepRun(index, steps[index])),
  };
}

const RUNNING_ID = "11111111-1111-4111-8111-111111111111";
const AWAITING_ID = "22222222-2222-4222-8222-222222222222";
const DONE_ID = "33333333-3333-4333-8333-333333333333";

describe("recoverInterruptedRuns", () => {
  it("marca runs não terminais como interrupted (server_shutdown) e não toca nos terminais", async () => {
    await runStore.save(
      makeRun(RUNNING_ID, "running", [{ status: "completed", finishedAt: NOW }, { status: "running", startedAt: NOW }]),
    );
    await runStore.save(makeRun(AWAITING_ID, "awaiting_input", [{ status: "awaiting_input", startedAt: NOW }]));
    const terminal = makeRun(DONE_ID, "completed", PIPELINE.steps.map(() => ({ status: "completed" as const })), NOW);
    await runStore.save(terminal);

    const clock = () => new Date("2026-11-18T08:00:00.000Z");
    const recovered = await recoverInterruptedRuns(runStore, clock);
    expect(recovered.sort()).toEqual([RUNNING_ID, AWAITING_ID].sort());

    const running = await runStore.get(RUNNING_ID);
    expect(running.status).toBe("interrupted");
    expect(running.finishedAt).toBe("2026-11-18T08:00:00.000Z");
    expect(running.steps[0]?.status).toBe("completed");
    expect(running.steps[1]).toMatchObject({
      status: "interrupted",
      interruptReason: "server_shutdown",
      finishedAt: "2026-11-18T08:00:00.000Z",
    });
    expect(running.steps.slice(2).every((step) => step.status === "waiting")).toBe(true);

    const awaiting = await runStore.get(AWAITING_ID);
    expect(awaiting.status).toBe("interrupted");
    expect(awaiting.steps[0]).toMatchObject({ status: "interrupted", interruptReason: "server_shutdown" });

    expect(await runStore.get(DONE_ID)).toEqual(terminal);
  });

  it("sem runs gravados → nada a recuperar", async () => {
    expect(await recoverInterruptedRuns(runStore)).toEqual([]);
  });
});
