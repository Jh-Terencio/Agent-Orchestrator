import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { PipelineInputSchema, type ApiIssue, type Pipeline, type PipelineInput, type StepInput } from "@orchestrator/shared";
import {
  ApiClientError,
  createPipeline,
  deletePipeline,
  duplicatePipeline,
  listPipelines,
  updatePipeline,
} from "../api/client";
import { PipelineBoxes } from "../components/PipelineBoxes";
import { StepEditor, type StepField } from "../components/StepEditor";

/** Erros por caminho do campo (`"name"`, `"steps"`, `"steps.0.command"`…). */
type FieldErrors = Record<string, string>;

const emptyStep = (): StepInput => ({ name: "", model: "", command: "", interactive: false });
const newDraft = (): PipelineInput => ({ name: "", steps: [emptyStep()] });

function toInput(pipeline: Pipeline): PipelineInput {
  return { name: pipeline.name, steps: pipeline.steps.map((step) => ({ ...step })) };
}

/** Converte `issues[].path` em mensagens por campo; o que não aponta para um campo vira erro geral. */
function mapIssues(issues: readonly ApiIssue[]): { fields: FieldErrors; general: string[] } {
  const fields: FieldErrors = {};
  const general: string[] = [];
  for (const issue of issues) {
    const key = issue.path.join(".");
    const known = key === "name" || key === "steps" || /^steps\.\d+\.(name|model|command|interactive|timeoutMinutes)$/.test(key);
    if (known) fields[key] ??= issue.message;
    else general.push(issue.message);
  }
  return { fields, general };
}

function stepErrors(errors: FieldErrors, index: number): Partial<Record<StepField, string>> {
  const prefix = `steps.${index}.`;
  const result: Partial<Record<StepField, string>> = {};
  for (const [key, message] of Object.entries(errors)) {
    if (key.startsWith(prefix)) result[key.slice(prefix.length) as StepField] = message;
  }
  return result;
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item!);
  return copy;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Editor de esteiras (US4, FR-021–FR-025): lista à esquerda, editor à direita. O estado do editor é
 * apenas um `PipelineInput` (Princípio IV), validado com `PipelineInputSchema` antes de enviar.
 */
export function PipelineEditorPage() {
  const nameId = useId();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  /** `null` = esteira nova ainda não salva. */
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** `null` = nenhuma esteira aberta. */
  const [draft, setDraft] = useState<PipelineInput | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback((pipeline: Pipeline | null) => {
    setCurrentId(pipeline?.id ?? null);
    setDraft(pipeline ? toInput(pipeline) : null);
    setErrors({});
    setGeneral(null);
  }, []);

  /** Recarrega a lista e abre `selectId` (ou a primeira esteira). */
  const refresh = useCallback(
    async (selectId?: string | null): Promise<void> => {
      const list = await listPipelines();
      setPipelines(list);
      open(list.find((pipeline) => pipeline.id === selectId) ?? list[0] ?? null);
    },
    [open],
  );

  useEffect(() => {
    refresh().catch((error: unknown) => setGeneral(errorText(error)));
  }, [refresh]);

  const current = pipelines.find((pipeline) => pipeline.id === currentId) ?? null;

  const change = (next: PipelineInput): void => {
    setDraft(next);
    setErrors({});
    setNotice(null);
  };

  const startNew = (): void => {
    open(null);
    change(newDraft());
  };

  const changeStep = (index: number, step: StepInput): void => {
    if (!draft) return;
    change({ ...draft, steps: draft.steps.map((item, i) => (i === index ? step : item)) });
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setGeneral(null);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiClientError && error.issues.length > 0) {
        const mapped = mapIssues(error.issues);
        setErrors(mapped.fields);
        setGeneral(mapped.general.length > 0 ? `${error.message}: ${mapped.general.join("; ")}` : error.message);
      } else {
        setGeneral(errorText(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const save = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!draft) return;
    const parsed = PipelineInputSchema.safeParse(draft);
    if (!parsed.success) {
      const mapped = mapIssues(
        parsed.error.issues.map((issue) => ({
          path: issue.path.filter((key): key is string | number => typeof key !== "symbol"),
          message: issue.message,
        })),
      );
      setErrors(mapped.fields);
      setGeneral(mapped.general.length > 0 ? mapped.general.join("; ") : "Corrija os campos indicados antes de salvar.");
      return;
    }
    await run(async () => {
      const savedPipeline =
        currentId === null ? await createPipeline(parsed.data) : await updatePipeline(currentId, parsed.data);
      await refresh(savedPipeline.id);
      setNotice("Esteira salva.");
    });
  };

  const duplicate = (): Promise<void> =>
    run(async () => {
      if (currentId === null) return;
      const copy = await duplicatePipeline(currentId);
      await refresh(copy.id);
      setNotice(`Cópia criada: ${copy.name}.`);
    });

  const remove = (): Promise<void> =>
    run(async () => {
      if (!current || current.isDefault) return;
      if (!window.confirm(`Excluir a esteira "${current.name}"?`)) return;
      await deletePipeline(current.id);
      await refresh();
      setNotice(`Esteira "${current.name}" excluída.`);
    });

  return (
    <section className="page pipeline-editor-page" aria-labelledby="pipelines-title">
      <h2 id="pipelines-title">Esteiras</h2>

      <div className="pipeline-editor-layout">
        <aside className="pipeline-list" aria-label="Esteiras salvas">
          <button type="button" className="primary" onClick={startNew} disabled={busy}>
            Nova esteira
          </button>
          <ul>
            {pipelines.map((pipeline) => (
              <li key={pipeline.id}>
                <button
                  type="button"
                  className="pipeline-list-item"
                  aria-current={pipeline.id === currentId && draft !== null ? "true" : undefined}
                  onClick={() => {
                    open(pipeline);
                    setNotice(null);
                  }}
                  disabled={busy}
                >
                  {pipeline.name}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="pipeline-editor">
          {general && (
            <p className="error" role="alert">
              {general}
            </p>
          )}
          {notice && (
            <p className="ok" role="status">
              {notice}
            </p>
          )}

          {draft === null ? (
            <p className="muted">Escolha uma esteira à esquerda ou crie uma nova.</p>
          ) : (
            <form onSubmit={(event) => void save(event)} noValidate>
              <div className="field">
                <label htmlFor={nameId}>Nome da esteira</label>
                <input
                  id={nameId}
                  maxLength={80}
                  value={draft.name}
                  aria-describedby={errors.name ? `${nameId}-error` : undefined}
                  aria-invalid={errors.name ? true : undefined}
                  onChange={(event) => change({ ...draft, name: event.target.value })}
                />
                {errors.name && (
                  <p className="error field-error" id={`${nameId}-error`}>
                    {errors.name}
                  </p>
                )}
              </div>

              {current && (
                <div className="row pipeline-actions">
                  <button type="button" onClick={() => void duplicate()} disabled={busy}>
                    Duplicar
                  </button>
                  {!current.isDefault && (
                    <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
                      Excluir
                    </button>
                  )}
                </div>
              )}

              <ol className="step-editor-list" aria-label="Passos da esteira">
                {draft.steps.map((step, index) => (
                  <StepEditor
                    key={index}
                    index={index}
                    count={draft.steps.length}
                    step={step}
                    errors={stepErrors(errors, index)}
                    onChange={(next) => changeStep(index, next)}
                    onMoveUp={() => change({ ...draft, steps: move(draft.steps, index, index - 1) })}
                    onMoveDown={() => change({ ...draft, steps: move(draft.steps, index, index + 1) })}
                    onRemove={() => change({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}
                  />
                ))}
              </ol>
              {errors.steps && <p className="error field-error">{errors.steps}</p>}

              <div className="row">
                <button type="button" onClick={() => change({ ...draft, steps: [...draft.steps, emptyStep()] })}>
                  Adicionar passo
                </button>
                <button type="submit" className="primary" disabled={busy} aria-busy={busy}>
                  Salvar
                </button>
              </div>

              {draft.steps.length > 0 && (
                <PipelineBoxes
                  label="Pré-visualização da esteira"
                  steps={draft.steps.map((step, index) => ({ ...step, id: step.id ?? `rascunho-${index}` }))}
                  stepRuns={null}
                  selectedIndex={null}
                  onSelect={() => {}}
                />
              )}
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
