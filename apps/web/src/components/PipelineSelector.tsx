import { useId } from "react";
import type { Pipeline } from "@orchestrator/shared";

export interface PipelineSelectorProps {
  pipelines: readonly Pipeline[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/** Escolha da esteira antes do envio (FR-022). */
export function PipelineSelector({ pipelines, value, onChange, disabled = false }: PipelineSelectorProps) {
  const id = useId();
  return (
    <div className="pipeline-selector row">
      <label htmlFor={id}>Esteira</label>
      <select id={id} value={value ?? ""} disabled={disabled || pipelines.length === 0} onChange={(event) => onChange(event.target.value)}>
        {pipelines.map((pipeline) => (
          <option key={pipeline.id} value={pipeline.id}>
            {pipeline.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A última esteira usada (`settings.lastPipelineId`) se ainda existir; senão a padrão (a primeira da lista). */
export function initialPipelineId(pipelines: readonly Pipeline[], lastPipelineId: string | null): string | null {
  if (lastPipelineId !== null && pipelines.some((pipeline) => pipeline.id === lastPipelineId)) return lastPipelineId;
  return (pipelines.find((pipeline) => pipeline.isDefault) ?? pipelines[0])?.id ?? null;
}
