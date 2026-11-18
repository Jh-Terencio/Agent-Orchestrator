import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultPipeline,
  type PermissionRequest,
  type RepoInfo,
  type Run,
  type RunStatus,
  type StepRun,
} from "@orchestrator/shared";
import * as client from "../src/api/client";
import { PermissionPrompt } from "../src/components/PermissionPrompt";
import { RunSummary } from "../src/components/RunSummary";
import { RunPage } from "../src/pages/RunPage";
import { RunStoreProvider } from "../src/state/run-store";

vi.mock("../src/api/ws", () => ({ connectEvents: () => () => {} }));
vi.mock("../src/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api/client")>();
  return {
    ...original,
    inspectRepo: vi.fn(),
    getSettings: vi.fn(),
    listPipelines: vi.fn(),
    startRun: vi.fn(),
    getActiveRun: vi.fn(),
    getStepOutput: vi.fn(),
    interrupt: vi.fn(),
    decidePermission: vi.fn(),
  };
});

const api = vi.mocked(client);
const NOW = "2026-11-17T12:00:00.000Z";
const REPO = "C:/repos/alvo";
const PIPELINE = createDefaultPipeline(NOW);
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const YOLO_LABEL = "Modo Yolo: o agente executa qualquer comando sem perguntar";
const YOLO_WARNING =
  "Com o Modo Yolo, o agente roda comandos na sua máquina sem pedir confirmação. Os bloqueios de git continuam valendo.";
const ALWAYS_LABEL = "Permitir sempre Bash(npm test:*) nesta execução";

const validRepo: RepoInfo = { path: REPO, valid: true, currentBranch: "main", problems: [] };

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    toolUseId: "toolu_1",
    toolName: "Bash",
    input: { command: "npm test", description: "roda os testes" },
    summary: "Bash: npm test",
    status: "pending",
    rule: null,
    requestedAt: NOW,
    decidedAt: null,
    ...overrides,
  };
}

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

function makeRun(status: RunStatus, first: Partial<StepRun>, overrides: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    pipeline: PIPELINE,
    repoPath: REPO,
    description: "Adicionar login",
    sourceBranch: "main",
    refSnapshot: [],
    initialBranch: "orchestrator/20261117-120000-adicionar-login",
    createdBranches: ["orchestrator/20261117-120000-adicionar-login"],
    finalBranch: null,
    yolo: false,
    permissionRules: [],
    status,
    startedAt: NOW,
    finishedAt: null,
    steps: PIPELINE.steps.map((_, index) => stepRun(index, index === 0 ? first : {})),
    ...overrides,
  };
}

const awaitingPermission = () =>
  makeRun("awaiting_permission", {
    status: "awaiting_permission",
    startedAt: NOW,
    permissionRequests: [permissionRequest()],
  });

function renderPage() {
  return render(
    <RunStoreProvider>
      <RunPage />
    </RunStoreProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue({ recentRepos: [], lastPipelineId: null });
  api.getActiveRun.mockResolvedValue(null);
  api.listPipelines.mockResolvedValue([PIPELINE]);
  api.inspectRepo.mockResolvedValue(validRepo);
  api.getStepOutput.mockResolvedValue([]);
  api.interrupt.mockResolvedValue(undefined);
  api.decidePermission.mockResolvedValue(undefined);
});

describe("Checkbox Modo Yolo", () => {
  it("aparece desmarcado e, marcado, mostra o aviso", async () => {
    const user = userEvent.setup();
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: YOLO_LABEL });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText(YOLO_WARNING)).not.toBeInTheDocument();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByText(YOLO_WARNING)).toBeInTheDocument();
  });

  it("enviar com o Yolo marcado passa yolo: true; um novo render volta desmarcado", async () => {
    const user = userEvent.setup();
    api.startRun.mockResolvedValue(makeRun("running", { status: "running" }, { yolo: true }));
    const view = renderPage();
    await user.type(screen.getByLabelText("Caminho do repositório"), REPO);
    await user.click(screen.getByRole("button", { name: "Usar" }));
    await screen.findByText(/A execução partirá de/);
    await user.type(screen.getByLabelText("Descrição da feature"), "Adicionar login");
    await user.click(screen.getByRole("checkbox", { name: YOLO_LABEL }));
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({ yolo: true }));

    view.unmount();
    renderPage();
    expect(await screen.findByRole("checkbox", { name: YOLO_LABEL })).not.toBeChecked();
  });
});

describe("PermissionPrompt", () => {
  it("mostra o pedido e os três botões, cada um chamando decidePermission com a decisão certa", async () => {
    const user = userEvent.setup();
    const request = permissionRequest();
    render(<PermissionPrompt runId={RUN_ID} request={request} />);
    expect(screen.getByText("Bash: npm test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Permitir uma vez" }));
    expect(api.decidePermission).toHaveBeenLastCalledWith(RUN_ID, request.id, "allow_once");
    await user.click(screen.getByRole("button", { name: ALWAYS_LABEL }));
    expect(api.decidePermission).toHaveBeenLastCalledWith(RUN_ID, request.id, "allow_always");
    await user.click(screen.getByRole("button", { name: "Negar" }));
    expect(api.decidePermission).toHaveBeenLastCalledWith(RUN_ID, request.id, "deny");
  });

  it("os botões ficam desabilitados enquanto a chamada está em andamento", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    api.decidePermission.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    render(<PermissionPrompt runId={RUN_ID} request={permissionRequest()} />);
    await user.click(screen.getByRole("button", { name: "Permitir uma vez" }));
    for (const name of ["Permitir uma vez", ALWAYS_LABEL, "Negar"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Negar" })).toBeEnabled());
  });

  it("erro na decisão aparece e reabilita os botões", async () => {
    const user = userEvent.setup();
    api.decidePermission.mockRejectedValue(
      new client.ApiClientError(409, "INVALID_STATE", "Este pedido de permissão já foi decidido."),
    );
    render(<PermissionPrompt runId={RUN_ID} request={permissionRequest()} />);
    await user.click(screen.getByRole("button", { name: "Negar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este pedido de permissão já foi decidido.");
    expect(screen.getByRole("button", { name: "Negar" })).toBeEnabled();
  });
});

describe("RunPage em awaiting_permission", () => {
  it("mostra o pedido pendente, o passo 'aguardando permissão' e o botão Interromper", async () => {
    const user = userEvent.setup();
    api.getActiveRun.mockResolvedValue(awaitingPermission());
    renderPage();
    const prompt = await screen.findByRole("region", { name: "Pedido de permissão" });
    expect(within(prompt).getByText("Bash: npm test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Passo 1: Specify \(aguardando permissão\)/ })).toBeInTheDocument();
    expect(screen.getByText("Aguardando permissão")).toBeInTheDocument();

    await user.click(within(prompt).getByRole("button", { name: ALWAYS_LABEL }));
    expect(api.decidePermission).toHaveBeenCalledWith(RUN_ID, permissionRequest().id, "allow_always");

    const interrupt = screen.getByRole("button", { name: "Interromper" });
    await user.click(interrupt);
    expect(api.interrupt).toHaveBeenCalledWith(RUN_ID);
  });

  it("o formulário de envio fica bloqueado enquanto o run aguarda permissão", async () => {
    api.getActiveRun.mockResolvedValue(awaitingPermission());
    renderPage();
    await screen.findByRole("region", { name: "Pedido de permissão" });
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });
});

describe("RunSummary com permissões", () => {
  it("mostra 'Modo Yolo' quando run.yolo", () => {
    render(<RunSummary run={makeRun("completed", { status: "completed" }, { yolo: true })} />);
    expect(screen.getByText("Modo Yolo")).toBeInTheDocument();
  });

  it("sem Yolo, lista os pedidos com a decisão", () => {
    const run = makeRun("completed", {
      status: "completed",
      permissionRequests: [
        permissionRequest({ status: "allowed_always", rule: "Bash(npm test:*)", decidedAt: NOW }),
        permissionRequest({
          id: "77777777-7777-4777-8777-777777777777",
          summary: "Bash: rm -rf dist",
          status: "denied",
          decidedAt: NOW,
        }),
      ],
    });
    render(<RunSummary run={run} />);
    expect(screen.queryByText("Modo Yolo")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Pedidos de permissão" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Bash: npm test");
    expect(items[0]).toHaveTextContent("permitido sempre (Bash(npm test:*))");
    expect(items[1]).toHaveTextContent("Bash: rm -rf dist");
    expect(items[1]).toHaveTextContent("negado");
  });
});
