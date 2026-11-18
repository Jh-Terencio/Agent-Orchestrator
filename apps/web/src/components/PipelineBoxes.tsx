import type { Step, StepRun } from "@orchestrator/shared";
import { StepBox } from "./StepBox";

export interface PipelineBoxesProps {
  steps: readonly Step[];
  /** Estado de cada passo; `null` antes do envio. */
  stepRuns: readonly StepRun[] | null;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

/** Sequência horizontal de caixas, uma por passo da esteira. */
export function PipelineBoxes({ steps, stepRuns, selectedIndex, onSelect }: PipelineBoxesProps) {
  return (
    <ol className="pipeline-boxes" aria-label="Passos da execução">
      {steps.map((step, index) => (
        <StepBox
          key={step.id}
          index={index}
          step={step}
          stepRun={stepRuns?.[index] ?? null}
          selected={selectedIndex === index}
          onSelect={onSelect}
        />
      ))}
    </ol>
  );
}
