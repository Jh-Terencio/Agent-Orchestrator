import { useId, useState } from "react";
import { deriveRule, type PermissionDecision, type PermissionRequest } from "@orchestrator/shared";
import { decidePermission } from "../api/client";

interface PermissionPromptProps {
  runId: string;
  request: PermissionRequest;
}

/**
 * Pedido de permissão pendente (FR-028/FR-029): o agente está parado esperando. A regra de
 * "permitir sempre" aparece no botão antes do clique.
 */
export function PermissionPrompt({ runId, request }: PermissionPromptProps) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rule = deriveRule(request.toolName, request.input);
  const description = typeof request.input.description === "string" ? request.input.description : null;

  const decide = async (decision: PermissionDecision): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await decidePermission(runId, request.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="permission-prompt" role="region" aria-labelledby={titleId}>
      <h3 id={titleId}>Pedido de permissão</h3>
      <p className="muted">O agente quer usar uma ferramenta e está esperando a sua decisão.</p>
      <p>
        <code className="permission-summary">{request.summary}</code>
      </p>
      {description && <p className="muted">{description}</p>}
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void decide("allow_once")}>
          Permitir uma vez
        </button>
        <button type="button" disabled={busy} onClick={() => void decide("allow_always")}>
          Permitir sempre <code>{rule}</code> nesta execução
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void decide("deny")}>
          Negar
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
