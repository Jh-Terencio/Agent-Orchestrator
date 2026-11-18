import type { Step, StepRun } from "@orchestrator/shared";
import { formatDuration, formatUsage, INTERRUPT_REASON_LABELS, STEP_STATUS_LABELS } from "../format";

export interface StepBoxProps {
  index: number;
  step: Step;
  /** `null` antes do envio (a caixa aparece como "aguardando"). */
  stepRun: StepRun | null;
  selected: boolean;
  onSelect: (index: number) => void;
}

/** Caixa de um passo (FR-013/FR-014): identificação, status, duração, consumo e erro. */
export function StepBox({ index, step, stepRun, selected, onSelect }: StepBoxProps) {
  const status = stepRun?.status ?? "waiting";
  const started = stepRun !== null && status !== "waiting";
  const settled = started && status !== "running";
  const usageText = formatUsage(stepRun?.usage ?? null);

  return (
    <li className={`step-box step-${status}`}>
      <button
        type="button"
        className="step-box-button"
        aria-pressed={selected}
        aria-label={`Passo ${index + 1}: ${step.name} (${STEP_STATUS_LABELS[status]})`}
        onClick={() => onSelect(index)}
      >
        <span className="step-box-head">
          <span className="step-name">{step.name}</span>
          {step.interactive && <span className="chip">interativo</span>}
        </span>
        <span className="step-meta">
          <span className="step-model">{step.model}</span>
          <code className="step-command">{step.command}</code>
        </span>
        <span className="step-status">{STEP_STATUS_LABELS[status]}</span>
        {status === "interrupted" && stepRun?.interruptReason && (
          <span className="step-interrupt-reason">{INTERRUPT_REASON_LABELS[stepRun.interruptReason]}</span>
        )}
        {stepRun?.durationMs != null && <span className="step-duration">{formatDuration(stepRun.durationMs)}</span>}
        {usageText !== null ? (
          <span className="step-usage">{usageText}</span>
        ) : (
          settled && <span className="step-usage muted">consumo indisponível</span>
        )}
      </button>
      {(status === "failed" || status === "interrupted") && stepRun?.errorMessage && (
        <p className="error step-error">{stepRun.errorMessage}</p>
      )}
    </li>
  );
}
