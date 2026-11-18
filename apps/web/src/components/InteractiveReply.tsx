import { useId, useState, type FormEvent } from "react";
import { advance, ApiClientError, reply } from "../api/client";

interface InteractiveReplyProps {
  runId: string;
  stepName: string;
}

/** Resposta ao passo em `awaiting_input` ou "Avançar" (FR-009/FR-009a). */
export function InteractiveReply({ runId, stepName }: InteractiveReplyProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>, onDone?: () => void): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      await action();
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!text.trim()) return;
    void run(
      () => reply(runId, text),
      () => setText(""),
    );
  };

  return (
    <form className="interactive-reply" onSubmit={onSubmit}>
      <label htmlFor={id}>Resposta ao passo {stepName}</label>
      <textarea id={id} rows={3} value={text} onChange={(event) => setText(event.target.value)} disabled={sending} />
      <div className="row">
        <button type="submit" disabled={sending || !text.trim()}>
          Responder
        </button>
        <button type="button" className="primary" disabled={sending} onClick={() => void run(() => advance(runId))}>
          Avançar
        </button>
        <span className="muted">Avançar conclui o passo, faz o commit e segue para o próximo.</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
