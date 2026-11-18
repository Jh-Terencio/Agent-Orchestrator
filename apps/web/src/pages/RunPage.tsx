import { useEffect, useState } from "react";
import type { Pipeline, RepoInfo } from "@orchestrator/shared";
import { ApiClientError, getActiveRun, listPipelines, startRun } from "../api/client";
import { FeatureInput } from "../components/FeatureInput";
import { InteractiveReply } from "../components/InteractiveReply";
import { PipelineBoxes } from "../components/PipelineBoxes";
import { RepoPicker } from "../components/RepoPicker";
import { RunSummary } from "../components/RunSummary";
import { StepOutputPanel } from "../components/StepOutputPanel";
import { useRunStore } from "../state/run-store";

/**
 * Página de execução: repositório e descrição no topo, caixas dos passos com a saída do passo
 * selecionado (US2), resposta interativa e resumo (US1).
 */
export function RunPage() {
  const { state, dispatch } = useRunStore();
  const { run } = state;
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchNotice, setBranchNotice] = useState<string | null>(null);
  /** Esteira mostrada antes do envio (todos os passos "aguardando"). */
  const [previewPipeline, setPreviewPipeline] = useState<Pipeline | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    listPipelines().then(
      (pipelines) => alive && setPreviewPipeline(pipelines[0] ?? null),
      (err: unknown) => console.warn("[run-page] não foi possível listar as esteiras", err),
    );
    return () => {
      alive = false;
    };
  }, []);

  // Seleciona automaticamente o passo em execução (ou aguardando resposta) sempre que ele muda.
  const currentIndex = run
    ? run.steps.findIndex((step) => step.status === "running" || step.status === "awaiting_input")
    : -1;
  useEffect(() => {
    if (currentIndex >= 0) setSelectedIndex(currentIndex);
  }, [run?.id, currentIndex]);
  useEffect(() => {
    if (run === null) setSelectedIndex(null);
  }, [run]);

  // Restaura a execução em andamento ao carregar a página.
  useEffect(() => {
    let alive = true;
    getActiveRun().then(
      (active) => {
        if (alive && active) dispatch({ type: "run.updated", run: active });
      },
      (err: unknown) => alive && setError(err instanceof ApiClientError ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [dispatch]);

  const runActive = run !== null && (run.status === "running" || run.status === "awaiting_input");
  const canSubmit = repo !== null && repo.valid && repo.currentBranch !== null && !runActive;

  const submit = async (): Promise<void> => {
    if (!repo || repo.currentBranch === null) return;
    setSubmitting(true);
    setError(null);
    setBranchNotice(null);
    try {
      const pipelines = await listPipelines();
      const pipeline = pipelines[0];
      if (!pipeline) throw new Error("Nenhuma esteira disponível.");
      const started = await startRun({
        repoPath: repo.path,
        pipelineId: pipeline.id,
        description,
        expectedBranch: repo.currentBranch,
      });
      dispatch({ type: "run.updated", run: started });
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "BRANCH_CHANGED") {
        const current = typeof err.details.currentBranch === "string" ? err.details.currentBranch : null;
        setRepo({ ...repo, currentBranch: current });
        setBranchNotice(
          `A branch do repositório mudou para ${current ?? "(nenhuma)"}. Confira e clique em "Enviar" de novo.`,
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const awaitingIndex = run ? run.steps.findIndex((step) => step.status === "awaiting_input") : -1;
  const awaitingStep = run && awaitingIndex >= 0 ? run.pipeline.steps[awaitingIndex] : undefined;
  const selectedStep = run && selectedIndex !== null ? run.pipeline.steps[selectedIndex] : undefined;

  return (
    <section className="page" aria-labelledby="run-page-title">
      <h2 id="run-page-title">Executar</h2>

      <RepoPicker
        repo={repo}
        onRepoChange={(info) => {
          setRepo(info);
          setBranchNotice(null);
        }}
        disabled={submitting}
      />
      {branchNotice && (
        <p className="warn" role="status" aria-label="Aviso de branch">
          {branchNotice}
        </p>
      )}

      <FeatureInput
        value={description}
        onChange={setDescription}
        onSubmit={() => void submit()}
        canSubmit={canSubmit}
        submitting={submitting}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {state.connection === "reconnecting" && (
        <p className="warn" role="status">
          Conexão perdida; reconectando…
        </p>
      )}

      {run === null && previewPipeline && (
        <PipelineBoxes steps={previewPipeline.steps} stepRuns={null} selectedIndex={null} onSelect={() => {}} />
      )}

      {run && (
        <>
          <PipelineBoxes
            steps={run.pipeline.steps}
            stepRuns={run.steps}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
          />

          {selectedStep && selectedIndex !== null && (
            <StepOutputPanel
              key={`${run.id}:${selectedIndex}`}
              runId={run.id}
              stepIndex={selectedIndex}
              step={selectedStep}
              started={(run.steps[selectedIndex]?.status ?? "waiting") !== "waiting"}
            />
          )}

          {awaitingStep && runActive && <InteractiveReply runId={run.id} stepName={awaitingStep.name} />}

          <RunSummary run={run} />
        </>
      )}
    </section>
  );
}
