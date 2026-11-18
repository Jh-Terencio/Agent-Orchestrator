import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultPipeline,
  type OutputEntry,
  type Run,
  type ServerEvent,
  type StepRun,
  type Usage,
} from "@orchestrator/shared";
import * as client from "../src/api/client";
import type { ConnectionStatus } from "../src/api/ws";
import { PipelineBoxes } from "../src/components/PipelineBoxes";
import { RunPage } from "../src/pages/RunPage";
import { RunStoreProvider } from "../src/state/run-store";

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
  return {
    ...original,
    getSettings: vi.fn(),
    listPipelines: vi.fn(),
    getActiveRun: vi.fn(),
    getStepOutput: vi.fn(),
  };
});

const api = vi.mocked(client);
const NOW = "2026-11-17T12:00:00.000Z";
const PIPELINE = createDefaultPipeline(NOW);
const RUN_ID = "11111111-1111-4111-8111-111111111111";

const usage = (extra: Partial<Usage>): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  costUsd: null,
  numTurns: null,
  ...extra,
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
    permissionRequests: [],
    ...overrides,
  };
}

function makeRun(steps: Partial<StepRun>[] = []): Run {
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
    steps: PIPELINE.steps.map((_, index) => stepRun(index, steps[index])),
  };
}

const entry = (seq: number, kind: OutputEntry["kind"], text: string): OutputEntry => ({ seq, at: NOW, kind, text });

function emit(event: ServerEvent): void {
  act(() => ws.onEvent!(event));
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
  ws.onStatus = null;
  api.getSettings.mockResolvedValue({ recentRepos: [], lastPipelineId: null });
  api.listPipelines.mockResolvedValue([PIPELINE]);
  api.getActiveRun.mockResolvedValue(null);
  api.getStepOutput.mockResolvedValue([]);
});

describe("PipelineBoxes / StepBox", () => {
  it("renderiza uma caixa por passo com nome, modelo e skill/comando (FR-013)", () => {
    render(<PipelineBoxes steps={PIPELINE.steps} stepRuns={null} selectedIndex={null} onSelect={() => {}} />);
    const boxes = screen.getAllByRole("listitem");
    expect(boxes).toHaveLength(PIPELINE.steps.length);
    PIPELINE.steps.forEach((step, index) => {
      const box = boxes[index]!;
      expect(within(box).getByText(step.name)).toBeInTheDocument();
      expect(within(box).getByText(step.model)).toBeInTheDocument();
      expect(within(box).getByText(step.command)).toBeInTheDocument();
      expect(within(box).getByText("aguardando")).toBeInTheDocument();
    });
    // Clarify e Implement são interativos na esteira padrão.
    expect(within(boxes[1]!).getByText("interativo")).toBeInTheDocument();
    expect(within(boxes[0]!).queryByText("interativo")).not.toBeInTheDocument();
  });

  it("mostra os seis status com rótulo em português (FR-014)", () => {
    const statuses: StepRun["status"][] = ["waiting", "running", "awaiting_input", "completed", "failed"];
    const runs = PIPELINE.steps.map((_, index) => stepRun(index, { status: statuses[index]! }));
    const { rerender } = render(
      <PipelineBoxes steps={PIPELINE.steps} stepRuns={runs} selectedIndex={null} onSelect={() => {}} />,
    );
    const labels = screen.getAllByRole("listitem").map((box) => box.querySelector(".step-status")?.textContent);
    expect(labels).toEqual(["aguardando", "executando", "aguardando resposta", "concluído", "com erro"]);

    rerender(
      <PipelineBoxes
        steps={PIPELINE.steps}
        stepRuns={runs.map((run, index) => (index === 0 ? { ...run, status: "interrupted" } : run))}
        selectedIndex={null}
        onSelect={() => {}}
      />,
    );
    expect(within(screen.getAllByRole("listitem")[0]!).getByText("interrompido")).toBeInTheDocument();
  });

  it("caixa failed mostra errorMessage; concluída mostra duração e consumo, ou 'consumo indisponível'", () => {
    const runs = [
      stepRun(0, {
        status: "completed",
        durationMs: 125_000,
        usage: usage({ inputTokens: 1500, outputTokens: 300, costUsd: 0.137 }),
      }),
      stepRun(1, { status: "completed", durationMs: 4_000, usage: null }),
      stepRun(2, { status: "failed", errorMessage: "O comando /speckit-plan não existe no repositório" }),
      stepRun(3),
      stepRun(4),
    ];
    render(<PipelineBoxes steps={PIPELINE.steps} stepRuns={runs} selectedIndex={null} onSelect={() => {}} />);
    const boxes = screen.getAllByRole("listitem");
    expect(within(boxes[0]!).getByText("02:05")).toBeInTheDocument();
    expect(within(boxes[0]!).getByText(/1\.500 entrada \/ 300 saída/)).toBeInTheDocument();
    expect(within(boxes[0]!).getByText(/US\$ 0,1370/)).toBeInTheDocument();
    expect(within(boxes[1]!).getByText("00:04")).toBeInTheDocument();
    expect(within(boxes[1]!).getByText("consumo indisponível")).toBeInTheDocument();
    expect(within(boxes[2]!).getByText("O comando /speckit-plan não existe no repositório")).toBeInTheDocument();
    expect(within(boxes[3]!).queryByText("consumo indisponível")).not.toBeInTheDocument();
  });
});

describe("RunPage com PipelineBoxes e StepOutputPanel", () => {
  it("antes do envio mostra as caixas da esteira padrão em 'aguardando'", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "Passos da execução" });
    const boxes = within(list).getAllByRole("listitem");
    expect(boxes).toHaveLength(5);
    for (const box of boxes) expect(within(box).getByText("aguardando")).toBeInTheDocument();
  });

  it("seleciona o passo em execução e mostra a entrada destacada e a saída, acrescentando novas do store", async () => {
    renderPage();
    emit({ type: "hello", activeRun: makeRun([{ status: "running", startedAt: NOW }]) });
    emit({
      type: "step.output",
      runId: RUN_ID,
      stepIndex: 0,
      entries: [entry(1, "system", "Entrada: /speckit-specify Adicionar login"), entry(2, "text", "Analisando…")],
    });

    const panel = await screen.findByRole("region", { name: "Saída do passo Specify" });
    const input = within(panel).getByLabelText("Entrada enviada ao agente");
    expect(input).toHaveTextContent("/speckit-specify Adicionar login");
    expect(within(panel).getByText("Analisando…")).toBeInTheDocument();
    expect(input.compareDocumentPosition(within(panel).getByText("Analisando…"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    const fetchesBefore = api.getStepOutput.mock.calls.length;
    emit({ type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [entry(3, "tool_use", "Read: spec.md")] });
    expect(within(panel).getByText("Read: spec.md")).toBeInTheDocument();
    expect(api.getStepOutput.mock.calls.length).toBe(fetchesBefore);
  });

  it("clicar numa caixa abre a saída daquele passo, buscando a saída completa se não estiver carregada", async () => {
    const user = userEvent.setup();
    api.getStepOutput.mockImplementation(async (_runId, index) =>
      index === 0 ? [entry(1, "system", "Entrada: /speckit-specify Adicionar login"), entry(2, "text", "Pronto.")] : [],
    );
    renderPage();
    emit({
      type: "hello",
      activeRun: makeRun([
        { status: "completed", startedAt: NOW, finishedAt: NOW, durationMs: 1000 },
        { status: "running", startedAt: NOW },
      ]),
    });
    await screen.findByRole("region", { name: "Saída do passo Clarify" });

    await user.click(screen.getByRole("button", { name: /Passo 1: Specify/ }));
    const panel = await screen.findByRole("region", { name: "Saída do passo Specify" });
    expect(await within(panel).findByText("Pronto.")).toBeInTheDocument();
    expect(api.getStepOutput).toHaveBeenCalledWith(RUN_ID, 0, undefined);
    expect(screen.getByRole("button", { name: /Passo 1: Specify/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("trunca tool_result acima de 4 KB com a opção 'mostrar tudo'", async () => {
    const user = userEvent.setup();
    renderPage();
    emit({ type: "hello", activeRun: makeRun([{ status: "running", startedAt: NOW }]) });
    const big = `${"a".repeat(4096)}FIM-DO-RESULTADO`;
    emit({ type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [entry(1, "tool_result", big)] });

    const panel = await screen.findByRole("region", { name: "Saída do passo Specify" });
    expect(within(panel).queryByText(/FIM-DO-RESULTADO/)).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "mostrar tudo" }));
    expect(within(panel).getByText(/FIM-DO-RESULTADO/)).toBeInTheDocument();
  });

  it("mostra a entrada de erro do passo e o indicador 'reconectando…'", async () => {
    renderPage();
    emit({ type: "hello", activeRun: makeRun([{ status: "running", startedAt: NOW }]) });
    emit({ type: "step.output", runId: RUN_ID, stepIndex: 0, entries: [entry(1, "error", "Falha do agente")] });
    const panel = await screen.findByRole("region", { name: "Saída do passo Specify" });
    expect(within(panel).getByText("Falha do agente").closest(".entry-error")).not.toBeNull();

    act(() => ws.onStatus!("reconnecting"));
    expect(screen.getByText(/reconectando…/i)).toBeInTheDocument();
    act(() => ws.onStatus!("connected"));
    await waitFor(() => expect(screen.queryByText("Conexão perdida; reconectando…")).not.toBeInTheDocument());
  });
});
