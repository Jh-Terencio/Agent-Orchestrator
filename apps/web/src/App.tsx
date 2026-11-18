import { useState } from "react";
import { PipelineEditorPage } from "./pages/PipelineEditorPage";
import { RunPage } from "./pages/RunPage";
import { RunStoreProvider, useRunStore } from "./state/run-store";

type Tab = "run" | "history" | "pipelines";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "run", label: "Executar" },
  { id: "history", label: "Histórico" },
  { id: "pipelines", label: "Esteiras" },
];

function ComingSoon({ title }: { title: string }) {
  return (
    <section className="page">
      <h2>{title}</h2>
      <p className="muted">Disponível em breve.</p>
    </section>
  );
}

function ConnectionBadge() {
  const { state } = useRunStore();
  const label = state.connection === "connected" ? "Conectado" : state.connection === "connecting" ? "Conectando…" : "Reconectando…";
  return (
    <span className={`badge badge-${state.connection}`} role="status">
      {label}
    </span>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("run");
  return (
    <RunStoreProvider>
      <header className="app-header">
        <h1>Agent Orchestrator</h1>
        <nav aria-label="Seções">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="tab"
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <ConnectionBadge />
      </header>
      <main>
        {tab === "run" && <RunPage />}
        {tab === "history" && <ComingSoon title="Histórico" />}
        {tab === "pipelines" && <PipelineEditorPage />}
      </main>
    </RunStoreProvider>
  );
}
