import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import type { OutputEntry, Run, ServerEvent } from "@orchestrator/shared";
import { connectEvents, type ConnectionStatus } from "../api/ws";

export interface RunState {
  run: Run | null;
  /** Saída recebida por índice de passo, em ordem de `seq`. */
  outputs: Record<number, OutputEntry[]>;
  /** Maior `seq` recebido por passo (para `afterSeq` ao reconectar). */
  lastSeq: Record<number, number>;
  /** `true` depois de `run.finished` para o run atual. */
  finished: boolean;
  connection: ConnectionStatus | "connecting";
}

export type RunAction =
  | ServerEvent
  | { type: "connection"; status: ConnectionStatus }
  /** Preenchimento de lacunas via `GET /runs/:id/steps/:i/output?afterSeq=`. */
  | { type: "outputs.fetched"; runId: string; stepIndex: number; entries: OutputEntry[] };

export const initialRunState: RunState = {
  run: null,
  outputs: {},
  lastSeq: {},
  finished: false,
  connection: "connecting",
};

function isTerminal(run: Run): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "interrupted";
}

/** Define o run atual; troca de run zera a saída acumulada. */
function withRun(state: RunState, run: Run | null): RunState {
  if (run === null) return { ...state, run: null, outputs: {}, lastSeq: {}, finished: false };
  if (state.run?.id !== run.id) return { ...state, run, outputs: {}, lastSeq: {}, finished: isTerminal(run) };
  return { ...state, run, finished: isTerminal(run) };
}

function appendOutputs(state: RunState, runId: string, stepIndex: number, entries: OutputEntry[]): RunState {
  if (state.run?.id !== runId) return state;
  let last = state.lastSeq[stepIndex] ?? 0;
  const fresh: OutputEntry[] = [];
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.seq <= last) continue;
    fresh.push(entry);
    last = entry.seq;
  }
  if (fresh.length === 0) return state;
  return {
    ...state,
    outputs: { ...state.outputs, [stepIndex]: [...(state.outputs[stepIndex] ?? []), ...fresh] },
    lastSeq: { ...state.lastSeq, [stepIndex]: last },
  };
}

/** Reducer dos eventos do servidor (contracts/websocket-events.md). Puro. */
export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "hello":
      return withRun(state, action.activeRun);
    case "run.updated":
      return withRun(state, action.run);
    case "run.finished":
      return { ...withRun(state, action.run), finished: true };
    case "step.output":
    case "outputs.fetched":
      return appendOutputs(state, action.runId, action.stepIndex, action.entries);
    case "connection":
      return { ...state, connection: action.status };
  }
}

const RunStateContext = createContext<RunState | null>(null);
const RunDispatchContext = createContext<Dispatch<RunAction> | null>(null);

/** Mantém o estado do run ativo alimentado pelo WebSocket. */
export function RunStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  useEffect(
    () =>
      connectEvents(
        (event) => dispatch(event),
        (status) => dispatch({ type: "connection", status }),
      ),
    [],
  );
  return (
    <RunStateContext.Provider value={state}>
      <RunDispatchContext.Provider value={dispatch}>{children}</RunDispatchContext.Provider>
    </RunStateContext.Provider>
  );
}

export function useRunStore(): { state: RunState; dispatch: Dispatch<RunAction> } {
  const state = useContext(RunStateContext);
  const dispatch = useContext(RunDispatchContext);
  if (state === null || dispatch === null) throw new Error("useRunStore precisa estar dentro de <RunStoreProvider>");
  return { state, dispatch };
}
