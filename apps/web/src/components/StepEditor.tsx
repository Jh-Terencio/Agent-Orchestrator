import { useId } from "react";
import { DEFAULT_TIMEOUT_MINUTES, type StepInput } from "@orchestrator/shared";

/** Sugestões do campo de modelo; qualquer outro nome aceito pela CLI também vale. */
export const MODEL_SUGGESTIONS = ["opus", "sonnet", "haiku"] as const;

export type StepField = "name" | "model" | "command" | "interactive" | "timeoutMinutes";

export interface StepEditorProps {
  index: number;
  count: number;
  step: StepInput;
  /** Mensagem de erro por campo (validação local ou `issues` do servidor). */
  errors: Partial<Record<StepField, string>>;
  onChange: (step: StepInput) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

/** Edição de um passo da esteira (FR-021): nome, modelo, skill/comando, interativo e limite de tempo. */
export function StepEditor({ index, count, step, errors, onChange, onMoveUp, onMoveDown, onRemove }: StepEditorProps) {
  const id = useId();
  const n = index + 1;
  const fieldId = (field: StepField) => `${id}-${field}`;
  const errorId = (field: StepField) => `${id}-${field}-error`;
  const describedBy = (field: StepField) => (errors[field] ? errorId(field) : undefined);
  const fieldError = (field: StepField) =>
    errors[field] ? (
      <p className="error field-error" id={errorId(field)}>
        {errors[field]}
      </p>
    ) : null;

  const changeTimeout = (raw: string): void => {
    const { timeoutMinutes: _old, ...rest } = step;
    // Vazio = padrão de 30 min (campo ausente); outros valores vão para a validação como estão.
    onChange(raw.trim() === "" ? rest : { ...rest, timeoutMinutes: Number(raw) });
  };

  return (
    <li className="step-editor">
      <div className="step-editor-head">
        <strong>Passo {n}</strong>
        <div className="row">
          <button type="button" onClick={onMoveUp} disabled={index === 0} aria-label={`Mover passo ${n} para cima`}>
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === count - 1}
            aria-label={`Mover passo ${n} para baixo`}
          >
            ↓
          </button>
          <button type="button" className="danger" onClick={onRemove} aria-label={`Remover passo ${n}`}>
            Remover
          </button>
        </div>
      </div>

      <div className="step-editor-fields">
        <div className="field">
          <label htmlFor={fieldId("name")}>Nome</label>
          <input
            id={fieldId("name")}
            aria-label={`Nome do passo ${n}`}
            aria-describedby={describedBy("name")}
            aria-invalid={errors.name ? true : undefined}
            maxLength={60}
            value={step.name}
            onChange={(event) => onChange({ ...step, name: event.target.value })}
          />
          {fieldError("name")}
        </div>

        <div className="field">
          <label htmlFor={fieldId("model")}>Modelo</label>
          <input
            id={fieldId("model")}
            aria-label={`Modelo do passo ${n}`}
            aria-describedby={describedBy("model")}
            aria-invalid={errors.model ? true : undefined}
            list={`${id}-models`}
            placeholder="sonnet"
            value={step.model}
            onChange={(event) => onChange({ ...step, model: event.target.value })}
          />
          <datalist id={`${id}-models`}>
            {MODEL_SUGGESTIONS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          {fieldError("model")}
        </div>

        <div className="field field-wide">
          <label htmlFor={fieldId("command")}>Skill ou comando</label>
          <input
            id={fieldId("command")}
            aria-label={`Skill ou comando do passo ${n}`}
            aria-describedby={describedBy("command")}
            aria-invalid={errors.command ? true : undefined}
            placeholder="/speckit-specify"
            value={step.command}
            onChange={(event) => onChange({ ...step, command: event.target.value })}
          />
          {fieldError("command")}
        </div>

        <div className="field">
          <label htmlFor={fieldId("timeoutMinutes")}>Limite (min)</label>
          <input
            id={fieldId("timeoutMinutes")}
            aria-label={`Limite em minutos do passo ${n}`}
            aria-describedby={describedBy("timeoutMinutes")}
            aria-invalid={errors.timeoutMinutes ? true : undefined}
            type="number"
            min={1}
            max={1440}
            step={1}
            placeholder={String(DEFAULT_TIMEOUT_MINUTES)}
            value={step.timeoutMinutes ?? ""}
            onChange={(event) => changeTimeout(event.target.value)}
          />
          {fieldError("timeoutMinutes")}
        </div>

        <div className="field field-check">
          <input
            id={fieldId("interactive")}
            type="checkbox"
            aria-label={`Interativo (passo ${n})`}
            checked={step.interactive}
            onChange={(event) => onChange({ ...step, interactive: event.target.checked })}
          />
          <label htmlFor={fieldId("interactive")}>Interativo</label>
          {fieldError("interactive")}
        </div>
      </div>
    </li>
  );
}
