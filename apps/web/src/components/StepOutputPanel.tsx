import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OutputEntry, Step } from "@orchestrator/shared";
import { getStepOutput } from "../api/client";
import { useRunStore } from "../state/run-store";

/** `tool_result` maior que isto aparece truncado, com "mostrar tudo" (research R10). */
export const TOOL_RESULT_DISPLAY_LIMIT = 4096;
const INPUT_PREFIX = "Entrada: ";
/** Distância do fim (px) em que o usuário ainda é considerado "no fim" para a rolagem automática. */
const STICKY_THRESHOLD_PX = 24;

export interface StepOutputPanelProps {
  runId: string;
  stepIndex: number;
  step: Step;
  /** `false` para passos ainda não iniciados: não há saída a buscar. */
  started: boolean;
}

/**
 * Saída de um passo (FR-015/FR-016), alimentada pelo store. Se o passo ainda não tem saída carregada
 * (passo anterior, execução restaurada), busca a saída completa uma vez pela API.
 */
export function StepOutputPanel({ runId, stepIndex, step, started }: StepOutputPanelProps) {
  const { state, dispatch } = useRunStore();
  const entries = state.run?.id === runId ? (state.outputs[stepIndex] ?? []) : [];
  const loaded = state.run?.id === runId && state.outputs[stepIndex] !== undefined;
  const fetched = useRef(new Set<string>());
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const key = `${runId}:${stepIndex}`;
    if (!started || loaded || fetched.current.has(key)) return;
    fetched.current.add(key);
    setLoadError(null);
    getStepOutput(runId, stepIndex, undefined).then(
      (fetchedEntries) => dispatch({ type: "outputs.fetched", runId, stepIndex, entries: fetchedEntries }),
      (error: unknown) => {
        fetched.current.delete(key);
        setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
  }, [runId, stepIndex, started, loaded, dispatch]);

  // Rolagem automática enquanto o usuário estiver no fim da lista.
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && stick.current) log.scrollTop = log.scrollHeight;
  }, [entries.length]);
  useEffect(() => {
    stick.current = true;
  }, [runId, stepIndex]);

  return (
    <section className="step-output" aria-label={`Saída do passo ${step.name}`}>
      <h3>
        Saída: {step.name} <code>{step.command}</code>
      </h3>
      {loadError && (
        <p className="error" role="alert">
          Não foi possível carregar a saída: {loadError}
        </p>
      )}
      <div
        ref={logRef}
        className="output-log"
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICKY_THRESHOLD_PX;
        }}
      >
        {entries.length === 0 ? (
          <p className="muted">{started ? "Sem saída até agora." : "O passo ainda não começou."}</p>
        ) : (
          entries.map((entry) => <OutputLine key={entry.seq} entry={entry} />)
        )}
      </div>
    </section>
  );
}

function OutputLine({ entry }: { entry: OutputEntry }) {
  if (entry.kind === "system" && entry.text.startsWith(INPUT_PREFIX)) {
    return (
      <div className="entry entry-input">
        <span className="entry-label" id={`entry-input-${entry.seq}`}>
          Entrada enviada ao agente
        </span>
        <pre aria-labelledby={`entry-input-${entry.seq}`}>{entry.text.slice(INPUT_PREFIX.length)}</pre>
      </div>
    );
  }
  switch (entry.kind) {
    case "tool_use":
      return <pre className="entry entry-tool_use">{entry.text}</pre>;
    case "tool_result":
      return <ToolResult text={entry.text} />;
    case "user_reply":
      return (
        <div className="entry entry-user_reply">
          <span className="entry-label">Sua resposta</span>
          <p>{entry.text}</p>
        </div>
      );
    case "error":
      return <p className="entry entry-error">{entry.text}</p>;
    case "system":
      return <p className="entry entry-system muted">{entry.text}</p>;
    case "text":
      return <p className="entry entry-text">{entry.text}</p>;
  }
}

function ToolResult({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = !expanded && text.length > TOOL_RESULT_DISPLAY_LIMIT;
  return (
    <div className="entry entry-tool_result">
      <pre>{truncated ? text.slice(0, TOOL_RESULT_DISPLAY_LIMIT) : text}</pre>
      {truncated && (
        <p className="muted">
          … mais {text.length - TOOL_RESULT_DISPLAY_LIMIT} caracteres.{" "}
          <button type="button" className="link" onClick={() => setExpanded(true)}>
            mostrar tudo
          </button>
        </p>
      )}
    </div>
  );
}
