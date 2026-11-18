import { useId, useState, type FormEvent, type KeyboardEvent } from "react";

interface FeatureInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Repositório válido e nenhuma execução ativa. */
  canSubmit: boolean;
  submitting?: boolean;
  /** Modo Yolo (FR-027): desmarcado por padrão, escolhido a cada envio. */
  yolo: boolean;
  onYoloChange: (value: boolean) => void;
}

/** Descrição da feature + "Enviar" (FR-003): desabilitado com descrição vazia, repositório inválido ou run ativo. */
export function FeatureInput({
  value,
  onChange,
  onSubmit,
  canSubmit,
  submitting = false,
  yolo,
  onYoloChange,
}: FeatureInputProps) {
  const id = useId();
  const yoloId = useId();
  const [warning, setWarning] = useState<string | null>(null);
  const empty = value.trim().length === 0;

  const trySubmit = (): void => {
    if (empty) {
      setWarning("Descreva a feature antes de enviar.");
      return;
    }
    if (!canSubmit || submitting) return;
    setWarning(null);
    onSubmit();
  };

  const onFormSubmit = (event: FormEvent): void => {
    event.preventDefault();
    trySubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      trySubmit();
    }
  };

  return (
    <form className="feature-input" onSubmit={onFormSubmit}>
      <label htmlFor={id}>Descrição da feature</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        placeholder="Descreva a feature que a esteira deve especificar e implementar…"
        onChange={(event) => {
          onChange(event.target.value);
          if (warning && event.target.value.trim()) setWarning(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="yolo">
        <input
          id={yoloId}
          type="checkbox"
          checked={yolo}
          disabled={submitting}
          onChange={(event) => onYoloChange(event.target.checked)}
        />
        <label htmlFor={yoloId}>Modo Yolo: o agente executa qualquer comando sem perguntar</label>
      </div>
      {yolo && (
        <p className="warn yolo-warning" role="note">
          Com o Modo Yolo, o agente roda comandos na sua máquina sem pedir confirmação. Os bloqueios de git
          continuam valendo.
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={empty || !canSubmit || submitting}>
          Enviar
        </button>
        {submitting && <span className="muted">Iniciando…</span>}
        {warning && <span className="warn">{warning}</span>}
      </div>
    </form>
  );
}
