import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPipeline, type RepoInfo, type Run, type StepRun, type Usage } from "@orchestrator/shared";
import * as client from "../src/api/client";
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
    reply: vi.fn(),
    advance: vi.fn(),
    getStepOutput: vi.fn(),
  };
});

const api = vi.mocked(client);
const NOW = "2026-11-17T12:00:00.000Z";
const REPO = "C:/repos/alvo";
const PIPELINE = createDefaultPipeline(NOW);

const validRepo = (branch = "main"): RepoInfo => ({ path: REPO, valid: true, currentBranch: branch, problems: [] });

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

function makeRun(overrides: Partial<Run> = {}, steps: Partial<StepRun>[] = []): Run {
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    pipeline: PIPELINE,
    repoPath: REPO,
    description: "Adicionar login",
    sourceBranch: "main",
    refSnapshot: [],
    initialBranch: "orchestrator/20261117-120000-adicionar-login",
    createdBranches: ["orchestrator/20261117-120000-adicionar-login"],
    finalBranch: null,
    status: "running",
    startedAt: NOW,
    finishedAt: null,
    steps: PIPELINE.steps.map((_, index) => stepRun(index, steps[index])),
    ...overrides,
  };
}

const usage = (extra: Partial<Usage>): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  costUsd: null,
  numTurns: null,
  ...extra,
});

function renderPage() {
  return render(
    <RunStoreProvider>
      <RunPage />
    </RunStoreProvider>,
  );
}

async function chooseRepo(user: ReturnType<typeof userEvent.setup>, path = REPO) {
  await user.clear(screen.getByLabelText("Caminho do repositório"));
  await user.type(screen.getByLabelText("Caminho do repositório"), path);
  await user.click(screen.getByRole("button", { name: "Usar" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue({ recentRepos: ["C:/repos/recente"], lastPipelineId: null });
  api.getActiveRun.mockResolvedValue(null);
  api.listPipelines.mockResolvedValue([PIPELINE]);
  api.inspectRepo.mockResolvedValue(validRepo());
  api.reply.mockResolvedValue(undefined);
  api.advance.mockResolvedValue(undefined);
  api.getStepOutput.mockResolvedValue([]);
});

describe("RepoPicker", () => {
  it("mostra a branch atual depois de inspecionar", async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseRepo(user);
    expect(api.inspectRepo).toHaveBeenCalledWith(REPO);
    expect(await screen.findByText(/A execução partirá de/)).toHaveTextContent("A execução partirá de main");
  });

  it("mostra os problemas quando o repositório é inválido", async () => {
    api.inspectRepo.mockResolvedValue({
      path: REPO,
      valid: false,
      currentBranch: "main",
      problems: ["dirty_worktree", "merge_or_rebase_in_progress"],
    });
    const user = userEvent.setup();
    renderPage();
    await chooseRepo(user);
    expect(await screen.findByText("Há alterações não commitadas")).toBeInTheDocument();
    expect(screen.getByText("Há merge/rebase em andamento")).toBeInTheDocument();
    expect(screen.queryByText(/A execução partirá de/)).not.toBeInTheDocument();
  });

  it("a lista de recentes preenche o caminho", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "C:/repos/recente" }));
    expect(screen.getByLabelText("Caminho do repositório")).toHaveValue("C:/repos/recente");
    expect(api.inspectRepo).toHaveBeenCalledWith("C:/repos/recente");
  });
});

describe("FeatureInput e envio", () => {
  it("Enviar fica desabilitado com descrição vazia ou só espaços", async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseRepo(user);
    await screen.findByText(/A execução partirá de/);
    const send = screen.getByRole("button", { name: "Enviar" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Descrição da feature"), "   ");
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Descrição da feature"), "Login");
    expect(send).toBeEnabled();
  });

  it("Enviar fica desabilitado com repositório inválido", async () => {
    api.inspectRepo.mockResolvedValue({ path: REPO, valid: false, currentBranch: null, problems: ["not_a_repo"] });
    const user = userEvent.setup();
    renderPage();
    await chooseRepo(user);
    await screen.findByText("A pasta não é um repositório Git");
    await user.type(screen.getByLabelText("Descrição da feature"), "Login");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("enviar chama startRun com expectedBranch igual à branch exibida", async () => {
    api.inspectRepo.mockResolvedValue(validRepo("develop"));
    api.startRun.mockResolvedValue(makeRun());
    const user = userEvent.setup();
    renderPage();
    await chooseRepo(user);
    await screen.findByText(/partirá de/);
    await user.type(screen.getByLabelText("Descrição da feature"), "Adicionar login");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(api.startRun).toHaveBeenCalledWith({
      repoPath: REPO,
      pipelineId: PIPELINE.id,
      description: "Adicionar login",
      expectedBranch: "develop",
    });
    expect(await screen.findByText("Specify")).toBeInTheDocument();
  });

  it("mostra o erro da API quando o envio é recusado", async () => {
    api.startRun.mockRejectedValue(
      new client.ApiClientError(422, "REPO_REJECTED", "O repositório não pode ser usado: há alterações não commitadas."),
    );
    const user = userEvent.setup();
    renderPage();
    await chooseRepo(user);
    await screen.findByText(/partirá de/);
    await user.type(screen.getByLabelText("Descrição da feature"), "Login");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O repositório não pode ser usado");
  });

  it("409 BRANCH_CHANGED atualiza a branch exibida, avisa e não reenvia sozinho", async () => {
    api.startRun.mockRejectedValueOnce(
      new client.ApiClientError(409, "BRANCH_CHANGED", "A branch mudou", [], { currentBranch: "feature-x" }),
    );
    api.startRun.mockResolvedValueOnce(makeRun());
    const user = userEvent.setup();
    renderPage();
    await chooseRepo(user);
    expect(await screen.findByText(/A execução partirá de/)).toHaveTextContent("partirá de main");
    await user.type(screen.getByLabelText("Descrição da feature"), "Login");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(screen.getByText(/A execução partirá de/)).toHaveTextContent("partirá de feature-x"));
    expect(screen.getByRole("status", { name: "Aviso de branch" })).toHaveTextContent("feature-x");
    expect(api.startRun).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(api.startRun).toHaveBeenCalledTimes(2);
    expect(api.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ expectedBranch: "feature-x" }));
  });
});

describe("InteractiveReply", () => {
  it("não aparece sem passo em awaiting_input", async () => {
    api.getActiveRun.mockResolvedValue(makeRun({}, [{ status: "running" }]));
    renderPage();
    expect(await screen.findByText("Specify")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Responder" })).not.toBeInTheDocument();
  });

  it("aparece com passo em awaiting_input, envia a resposta e avança", async () => {
    const run = makeRun({ status: "awaiting_input" }, [{ status: "completed" }, { status: "awaiting_input" }]);
    api.getActiveRun.mockResolvedValue(run);
    const user = userEvent.setup();
    renderPage();

    const respond = await screen.findByRole("button", { name: "Responder" });
    expect(respond).toBeDisabled();
    await user.type(screen.getByLabelText("Resposta ao passo Clarify"), "Use OAuth");
    await user.click(respond);
    expect(api.reply).toHaveBeenCalledWith(run.id, "Use OAuth");
    await waitFor(() => expect(screen.getByLabelText("Resposta ao passo Clarify")).toHaveValue(""));

    await user.click(screen.getByRole("button", { name: "Avançar" }));
    expect(api.advance).toHaveBeenCalledWith(run.id);
  });

  it("Enviar fica desabilitado enquanto há execução ativa", async () => {
    api.getActiveRun.mockResolvedValue(makeRun({ status: "awaiting_input" }, [{ status: "awaiting_input" }]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Responder" });
    await chooseRepo(user);
    await screen.findByText(/partirá de/);
    await user.type(screen.getByLabelText("Descrição da feature"), "Outra");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });
});

describe("RunSummary", () => {
  it("mostra status, branch final, branches criadas e os totais de computeRunTotals", () => {
    const run = makeRun(
      {
        status: "completed",
        finalBranch: "001-login",
        createdBranches: ["orchestrator/20261117-120000-adicionar-login", "001-login"],
        finishedAt: NOW,
      },
      [
        { status: "completed", durationMs: 60_000, usage: usage({ inputTokens: 1000, outputTokens: 200, costUsd: 0.13 }) },
        { status: "completed", durationMs: 65_000, usage: usage({ inputTokens: 500, outputTokens: 100, costUsd: 0.007 }) },
      ],
    );
    render(<RunSummary run={run} />);
    const summary = screen.getByRole("region", { name: "Resumo da execução" });
    expect(within(summary).getByText("Concluída")).toBeInTheDocument();
    expect(within(summary).getByText("Branch final:").parentElement).toHaveTextContent("001-login");
    const branches = within(summary).getByRole("list", { name: "Branches criadas" });
    expect(within(branches).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "orchestrator/20261117-120000-adicionar-login",
      "001-login",
    ]);
    expect(summary).toHaveTextContent("Duração total: 02:05");
    expect(summary).toHaveTextContent("1.500 entrada / 300 saída");
    expect(summary).toHaveTextContent("US$ 0,1370");
  });

  it("mostra 'consumo indisponível' quando nenhum passo reportou consumo", () => {
    render(<RunSummary run={makeRun({ status: "failed", finishedAt: NOW }, [{ status: "failed" }])} />);
    const summary = screen.getByRole("region", { name: "Resumo da execução" });
    expect(within(summary).getByText("Com erro")).toBeInTheDocument();
    expect(summary).toHaveTextContent("consumo indisponível");
  });

  it("mostra os totais também com o run em andamento", () => {
    render(<RunSummary run={makeRun({}, [{ status: "completed", durationMs: 5_000, usage: usage({ costUsd: 0.01 }) }])} />);
    const summary = screen.getByRole("region", { name: "Resumo da execução" });
    expect(within(summary).getByText("Em andamento")).toBeInTheDocument();
    expect(summary).toHaveTextContent("Duração total: 00:05");
    expect(summary).toHaveTextContent("US$ 0,0100");
  });
});
