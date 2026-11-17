import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const container = document.getElementById("root");
if (!container) throw new Error("Elemento #root não encontrado");

createRoot(container).render(
  <StrictMode>
    <h1>Agent Orchestrator</h1>
  </StrictMode>,
);
