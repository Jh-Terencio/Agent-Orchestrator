import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPipeline, type Pipeline, type PipelineInput } from "@orchestrator/shared";
import * as client from "../src/api/client";
import { ApiClientError } from "../src/api/client";
import { PipelineEditorPage } from "../src/pages/PipelineEditorPage";
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
    createPipeline: vi.fn(),
    updatePipeline: vi.fn(),
    duplicatePipeline: vi.fn(),
    deletePipeline: vi.fn(),
    startRun: vi.fn(),
    getActiveRun: vi.fn(),
    getStepOutput: vi.fn(),
  };
});

const api = vi.mocked(client);
const NOW = "2026-11-17T12:00:00.000Z";
const DEFAULT = createDefaultPipeline(NOW);
const MINI: Pipeline = {
  schemaVersion: 1,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Mini",
  isDefault: false,
  createdAt: NOW,
  updatedAt: NOW,
  steps: [
    { id: "33333333-3333-4333-8333-333333333331", name: "Specify", model: "sonnet", command: "/speckit-specify", interactive: false },
    { id: "33333333-3333-4333-8333-333333333332", name: "Plan", model: "opus", command: "/speckit-plan", interactive: false },
  ],
};

function saved(input: PipelineInput, id = "44444444-4444-4444-8444-444444444444"): Pipeline {
  return {
    schemaVersion: 1,
    id,
    name: input.name,
    isDefault: false,
    createdAt: NOW,
    updatedAt: NOW,
    steps: input.steps.map((step, index) => ({ ...step, id: step.id ?? `55555555-5555-4555-8555-55555555555${index}` })),
  };
}

const previewNames = () =>
  within(screen.getByRole("list", { name: "Pré-visualização da esteira" }))
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".step-name")?.textContent);

beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue({ recentRepos: [], lastPipelineId: null });
  api.listPipelines.mockResolvedValue([DEFAULT, MINI]);
  api.getActiveRun.mockResolvedValue(null);
  api.getStepOutput.mockResolvedValue([]);
  api.createPipeline.mockImplementation(async (input) => saved(input));
  api.updatePipeline.mockImplementation(async (id, input) => saved(input, id));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openMini(user: ReturnType<typeof userEvent.setup>) {
  render(<PipelineEditorPage />);
  await user.click(await screen.findByRole("button", { name: "Mini" }));
  await screen.findByDisplayValue("Mini");
}

describe("PipelineEditorPage", () => {
  it("cria uma esteira nova com dois passos e chama createPipeline", async () => {
    const user = userEvent.setup();
    render(<PipelineEditorPage />);
    await user.click(await screen.findByRole("button", { name: "Nova esteira" }));

    await user.type(screen.getByLabelText("Nome da esteira"), "Nova");
    await user.type(screen.getByLabelText("Nome do passo 1"), "Specify");
    await user.type(screen.getByLabelText("Modelo do passo 1"), "sonnet");
    await user.type(screen.getByLabelText("Skill ou comando do passo 1"), "/speckit-specify");

    await user.click(screen.getByRole("button", { name: "Adicionar passo" }));
    await user.type(screen.getByLabelText("Nome do passo 2"), "Clarify");
    await user.type(screen.getByLabelText("Modelo do passo 2"), "haiku");
    await user.type(screen.getByLabelText("Skill ou comando do passo 2"), "/speckit-clarify");
    await user.click(screen.getByLabelText("Interativo (passo 2)"));
    await user.type(screen.getByLabelText("Limite em minutos do passo 2"), "45");

    expect(previewNames()).toEqual(["Specify", "Clarify"]);
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(api.createPipeline).toHaveBeenCalledTimes(1));
    expect(api.createPipeline).toHaveBeenCalledWith({
      name: "Nova",
      steps: [
        { name: "Specify", model: "sonnet", command: "/speckit-specify", interactive: false },
        { name: "Clarify", model: "haiku", command: "/speckit-clarify", interactive: true, timeoutMinutes: 45 },
      ],
    });
    expect(await screen.findByText("Esteira salva.")).toBeInTheDocument();
  });

  it("o campo de modelo sugere opus, sonnet e haiku", async () => {
    const user = userEvent.setup();
    await openMini(user);
    const input = screen.getByLabelText("Modelo do passo 1");
    const list = document.getElementById(input.getAttribute("list") ?? "");
    expect([...(list?.querySelectorAll("option") ?? [])].map((option) => option.value)).toEqual(["opus", "sonnet", "haiku"]);
  });

  it("move passos para cima/baixo, remove e salva a nova ordem com updatePipeline", async () => {
    const user = userEvent.setup();
    await openMini(user);
    expect(previewNames()).toEqual(["Specify", "Plan"]);

    await user.click(screen.getByRole("button", { name: "Mover passo 2 para cima" }));
    expect(previewNames()).toEqual(["Plan", "Specify"]);
    await user.click(screen.getByRole("button", { name: "Mover passo 1 para baixo" }));
    expect(previewNames()).toEqual(["Specify", "Plan"]);
    expect(screen.getByRole("button", { name: "Mover passo 1 para cima" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mover passo 2 para baixo" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Mover passo 2 para cima" }));
    await user.click(screen.getByRole("button", { name: "Remover passo 2" }));
    expect(previewNames()).toEqual(["Plan"]);

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.updatePipeline).toHaveBeenCalledTimes(1));
    expect(api.updatePipeline).toHaveBeenCalledWith(MINI.id, { name: "Mini", steps: [MINI.steps[1]] });
  });

  it("mostra erros de validação local ao lado do campo sem chamar o servidor", async () => {
    const user = userEvent.setup();
    await openMini(user);
    await user.clear(screen.getByLabelText("Nome da esteira"));
    await user.clear(screen.getByLabelText("Skill ou comando do passo 2"));
    await user.type(screen.getByLabelText("Limite em minutos do passo 1"), "0");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Informe um nome para a esteira")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome da esteira")).toHaveAccessibleDescription("Informe um nome para a esteira");
    expect(screen.getByLabelText("Skill ou comando do passo 2")).toHaveAccessibleDescription(
      "Informe a skill ou comando do passo",
    );
    expect(screen.getByLabelText("Limite em minutos do passo 1")).toHaveAccessibleDescription(
      "O limite de tempo deve estar entre 1 e 1440 minutos",
    );
    expect(api.updatePipeline).not.toHaveBeenCalled();
  });

  it("mostra erros do servidor no campo indicado por path", async () => {
    api.updatePipeline.mockRejectedValue(
      new ApiClientError(400, "VALIDATION_FAILED", "Dados da esteira inválidos", [
        { path: ["name"], message: "Já existe uma esteira com este nome" },
      ]),
    );
    const user = userEvent.setup();
    await openMini(user);
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Já existe uma esteira com este nome")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome da esteira")).toHaveAccessibleDescription("Já existe uma esteira com este nome");
  });

  it("Duplicar chama duplicatePipeline e abre a cópia", async () => {
    const copy: Pipeline = { ...MINI, id: "66666666-6666-4666-8666-666666666666", name: "Mini (cópia)" };
    api.duplicatePipeline.mockResolvedValue(copy);
    const user = userEvent.setup();
    await openMini(user);
    api.listPipelines.mockResolvedValue([DEFAULT, MINI, copy]);
    await user.click(screen.getByRole("button", { name: "Duplicar" }));
    expect(api.duplicatePipeline).toHaveBeenCalledWith(MINI.id);
    expect(await screen.findByDisplayValue("Mini (cópia)")).toBeInTheDocument();
  });

  it("Excluir pede confirmação e chama deletePipeline", async () => {
    const confirm = vi.spyOn(window, "confirm");
    api.deletePipeline.mockResolvedValue(undefined);
    const user = userEvent.setup();
    await openMini(user);

    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Excluir" }));
    expect(api.deletePipeline).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    api.listPipelines.mockResolvedValue([DEFAULT]);
    await user.click(screen.getByRole("button", { name: "Excluir" }));
    expect(confirm).toHaveBeenLastCalledWith('Excluir a esteira "Mini"?');
    await waitFor(() => expect(api.deletePipeline).toHaveBeenCalledWith(MINI.id));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Mini" })).not.toBeInTheDocument());
  });

  it("a esteira padrão não tem o botão Excluir", async () => {
    const user = userEvent.setup();
    render(<PipelineEditorPage />);
    await user.click(await screen.findByRole("button", { name: "Spec Kit (padrão)" }));
    await screen.findByDisplayValue("Spec Kit (padrão)");
    expect(screen.queryByRole("button", { name: "Excluir" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duplicar" })).toBeInTheDocument();
  });
});

describe("PipelineSelector na RunPage", () => {
  function renderRunPage() {
    return render(
      <RunStoreProvider>
        <RunPage />
      </RunStoreProvider>,
    );
  }

  const boxNames = () =>
    within(screen.getByRole("list", { name: "Passos da execução" }))
      .getAllByRole("listitem")
      .map((item) => item.querySelector(".step-name")?.textContent);

  it("lista as esteiras e começa pela última escolhida (settings.lastPipelineId)", async () => {
    api.getSettings.mockResolvedValue({ recentRepos: [], lastPipelineId: MINI.id });
    renderRunPage();
    const select = await screen.findByLabelText("Esteira");
    await waitFor(() => expect(select).toHaveValue(MINI.id));
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Spec Kit (padrão)",
      "Mini",
    ]);
    await waitFor(() => expect(boxNames()).toEqual(["Specify", "Plan"]));
  });

  it("sem lastPipelineId válido começa pela padrão; trocar a esteira muda as caixas e o envio", async () => {
    api.getSettings.mockResolvedValue({ recentRepos: [], lastPipelineId: "77777777-7777-4777-8777-777777777777" });
    api.inspectRepo.mockResolvedValue({ path: "C:/repos/alvo", valid: true, currentBranch: "main", problems: [] });
    api.startRun.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderRunPage();
    const select = await screen.findByLabelText("Esteira");
    await waitFor(() => expect(select).toHaveValue(DEFAULT.id));
    await waitFor(() => expect(boxNames()).toHaveLength(5));

    await user.selectOptions(select, MINI.id);
    expect(boxNames()).toEqual(["Specify", "Plan"]);

    await user.type(screen.getByLabelText("Caminho do repositório"), "C:/repos/alvo");
    await user.click(screen.getByRole("button", { name: "Usar" }));
    await screen.findByText(/A execução partirá de/);
    await user.type(screen.getByLabelText("Descrição da feature"), "Adicionar login");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: MINI.id })));
  });
});
