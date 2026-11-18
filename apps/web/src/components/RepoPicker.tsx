import { useEffect, useId, useState, type FormEvent } from "react";
import type { RepoInfo } from "@orchestrator/shared";
import { ApiClientError, getSettings, inspectRepo } from "../api/client";
import { PROBLEM_LABELS } from "../format";

interface RepoPickerProps {
  /** Repositório inspecionado (controlado pela página, que o atualiza em `BRANCH_CHANGED`). */
  repo: RepoInfo | null;
  onRepoChange: (repo: RepoInfo | null) => void;
  disabled?: boolean;
}

/** Caminho do repositório + recentes; mostra a branch de partida (FR-003a) ou os problemas (FR-002). */
export function RepoPicker({ repo, onRepoChange, disabled = false }: RepoPickerProps) {
  const inputId = useId();
  const [path, setPath] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSettings().then(
      (settings) => alive && setRecent(settings.recentRepos),
      () => alive && setRecent([]),
    );
    return () => {
      alive = false;
    };
  }, []);

  const inspect = async (target: string): Promise<void> => {
    const trimmed = target.trim();
    if (!trimmed) return;
    setChecking(true);
    setError(null);
    try {
      onRepoChange(await inspectRepo(trimmed));
    } catch (err) {
      onRepoChange(null);
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void inspect(path);
  };

  return (
    <section className="repo-picker" aria-label="Repositório">
      <form className="row" onSubmit={onSubmit}>
        <label htmlFor={inputId}>Caminho do repositório</label>
        <input
          id={inputId}
          type="text"
          value={path}
          placeholder="C:\caminho\do\repositorio"
          onChange={(event) => setPath(event.target.value)}
          disabled={disabled || checking}
          spellCheck={false}
        />
        <button type="submit" disabled={disabled || checking || !path.trim()}>
          Usar
        </button>
      </form>

      {recent.length > 0 && (
        <div className="recent">
          <span className="muted">Recentes:</span>
          {recent.map((item) => (
            <button
              key={item}
              type="button"
              className="link"
              disabled={disabled || checking}
              onClick={() => {
                setPath(item);
                void inspect(item);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}

      {checking && <p className="muted">Verificando o repositório…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {repo && !checking && (
        <div className="repo-status">
          {repo.valid ? (
            <p className="ok">
              A execução partirá de <code>{repo.currentBranch}</code>
            </p>
          ) : (
            <ul className="problems" aria-label="Problemas do repositório">
              {repo.problems.map((problem) => (
                <li key={problem}>{PROBLEM_LABELS[problem]}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
