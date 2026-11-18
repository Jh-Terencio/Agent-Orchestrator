import { useEffect, useState } from "react";
import type { RepoInfo } from "@orchestrator/shared";
import { ApiClientError, getActiveRun, listPipelines, startRun } from "../api/client";
import { FeatureInput } from "../components/FeatureInput";
import { InteractiveReply } from "../components/InteractiveReply";
import { RepoPicker } from "../components/RepoPicker";
import { RunSummary } from "../components/RunSummary";
import { STEP_STATUS_LABELS } from "../format";
import { useRunStore } from "../state/run-store";

/** Página de execução (US1): repositório e descrição no topo, passos, resposta interativa e resumo. */
export function RunPage() {
  const { state, dispatch } = useRunStore();
  const { run } = state;
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchNotice, setBranchNotice] = useState<string | null>(null);

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

      {run && (
        <>
          <ol className="steps" aria-label="Passos da execução">
            {run.pipeline.steps.map((step, index) => {
              const status = run.steps[index]?.status ?? "waiting";
              const message = run.steps[index]?.errorMessage;
              return (
                <li key={step.id} className={`step step-${status}`}>
                  <span className="step-name">{step.name}</span>{" "}
                  <span className="step-status">{STEP_STATUS_LABELS[status]}</span>
                  {message && <p className="error">{message}</p>}
                </li>
              );
            })}
          </ol>

          {awaitingStep && runActive && <InteractiveReply runId={run.id} stepName={awaitingStep.name} />}

          <RunSummary run={run} />
        </>
      )}
    </section>
  );
}
