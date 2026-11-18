import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultPipeline,
  type InterruptReason,
  type Run,
  type RunStatus,
  type ServerEvent,
  type StepRun,
} from "@orchestrator/shared";
import * as client from "../src/api/client";
import { PipelineBoxes } from "../src/components/PipelineBoxes";
import { RunPage } from "../src/pages/RunPage";
import { RunStoreProvider } from "../src/state/run-store";

const ws = vi.hoisted(() => ({ onEvent: null as ((event: ServerEvent) => void) | null }));

vi.mock("../src/api/ws", () => ({
  connectEvents: (onEvent: (event: ServerEvent) => void) => {
    ws.onEvent = onEvent;
    return () => {};
  },
}));
vi.mock("../src/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api/client")>();
  return {
    ...original,
    getSettings: vi.fn(),
    listPipelines: vi.fn(),
    getActiveRun: vi.fn(),
    getStepOutput: vi.fn(),
    interrupt: vi.fn(),
  };
});

const api = vi.mocked(client);
const NOW = "2026-11-17T12:00:00.000Z";
const PIPELINE = createDefaultPipeline(NOW);
const RUN_ID = "11111111-1111-4111-8111-111111111111";

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

function makeRun(status: RunStatus, steps: Partial<StepRun>[]): Run {
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
    status,
    startedAt: NOW,
    finishedAt: status === "running" || status === "awaiting_input" ? null : NOW,
    steps: PIPELINE.steps.map((_, index) => stepRun(index, steps[index])),
  };
}

function renderPage() {
  return render(
    <RunStoreProvider>
      <RunPage />
    </RunStoreProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  ws.onEvent = null;
  api.getSettings.mockResolvedValue({ recentRepos: [], lastPipelineId: null });
  api.listPipelines.mockResolvedValue([PIPELINE]);
  api.getStepOutput.mockResolvedValue([]);
  api.interrupt.mockResolvedValue(undefined);
});

describe("Botão Interromper", () => {
  it.each<[RunStatus, Partial<StepRun>]>([
    ["running", { status: "running", startedAt: NOW }],
    ["awaiting_input", { status: "awaiting_input", startedAt: NOW }],
  ])("visível e habilitado com o run em %s; chama interrupt e desabilita até o próximo run.updated", async (status, step) => {
    const user = userEvent.setup();
    const run = makeRun(status, [step]);
    api.getActiveRun.mockResolvedValue(run);
    renderPage();

    const button = await screen.findByRole("button", { name: "Interromper" });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(api.interrupt).toHaveBeenCalledWith(RUN_ID);
    expect(button).toBeDisabled();

    act(() => ws.onEvent!({ type: "run.updated", run: structuredClone(run) }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Interromper" })).toBeEnabled());
  });

  it.each<RunStatus>(["completed", "failed", "interrupted"])("ausente com o run em %s", async (status) => {
    const run = makeRun(status, [{ status: status === "completed" ? "completed" : status }]);
    api.getActiveRun.mockResolvedValue(null);
    renderPage();
    await waitFor(() => expect(ws.onEvent).not.toBeNull());
    act(() => ws.onEvent!({ type: "run.finished", run }));
    await screen.findAllByRole("listitem");
    expect(screen.queryByRole("button", { name: "Interromper" })).not.toBeInTheDocument();
  });

  it("falha ao interromper mostra o erro e reabilita o botão", async () => {
    const user = userEvent.setup();
    api.getActiveRun.mockResolvedValue(makeRun("running", [{ status: "running", startedAt: NOW }]));
    api.interrupt.mockRejectedValue(new client.ApiClientError(409, "INVALID_STATE", "Esta execução não está em andamento."));
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Interromper" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Esta execução não está em andamento.");
    expect(screen.getByRole("button", { name: "Interromper" })).toBeEnabled();
  });
});

describe("Caixa interrompida", () => {
  it.each<[InterruptReason, string]>([
    ["user", "interrompido pelo usuário"],
    ["timeout", "tempo limite excedido"],
    ["server_shutdown", "aplicação encerrada"],
  ])("motivo %s → %s", (reason, label) => {
    const runs = PIPELINE.steps.map((_, index) =>
      stepRun(index, index === 0 ? { status: "interrupted", interruptReason: reason } : {}),
    );
    render(<PipelineBoxes steps={PIPELINE.steps} stepRuns={runs} selectedIndex={null} onSelect={() => {}} />);
    const box = screen.getAllByRole("listitem")[0]!;
    expect(within(box).getByText("interrompido")).toBeInTheDocument();
    expect(within(box).getByText(label)).toBeInTheDocument();
  });
});
