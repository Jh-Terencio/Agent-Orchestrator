import { createContext, useContext, useEffect, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import type { OutputEntry, Run, ServerEvent } from "@orchestrator/shared";
import { getStepOutput } from "../api/client";
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

/**
 * Mescla entradas por `seq`, ignorando as já vistas. Entradas buscadas pela API podem chegar depois de
 * entradas mais novas do WebSocket; por isso é uma mescla ordenada, e não só um acréscimo no fim.
 */
function appendOutputs(state: RunState, runId: string, stepIndex: number, entries: OutputEntry[]): RunState {
  if (state.run?.id !== runId) return state;
  const current = state.outputs[stepIndex] ?? [];
  const seen = new Set(current.map((entry) => entry.seq));
  const fresh: OutputEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.seq)) continue;
    seen.add(entry.seq);
    fresh.push(entry);
  }
  if (fresh.length === 0) return state;
  const last = state.lastSeq[stepIndex] ?? 0;
  const inOrder = fresh.every((entry, i) => entry.seq > (i === 0 ? last : fresh[i - 1]!.seq));
  const merged = inOrder ? [...current, ...fresh] : [...current, ...fresh].sort((a, b) => a.seq - b.seq);
  return {
    ...state,
    outputs: { ...state.outputs, [stepIndex]: merged },
    lastSeq: { ...state.lastSeq, [stepIndex]: merged[merged.length - 1]!.seq },
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

/**
 * Depois de uma reconexão, busca a saída perdida de cada passo já iniciado (`afterSeq` = maior `seq`
 * recebido, ou -1 se nada chegou) e despacha como `outputs.fetched`; o reducer descarta repetidas.
 */
export async function resyncOutputs(
  run: Run,
  lastSeq: Record<number, number>,
  dispatch: Dispatch<RunAction>,
): Promise<void> {
  const started = run.steps.flatMap((step, index) => (step.status === "waiting" ? [] : [index]));
  await Promise.all(
    started.map(async (index) => {
      try {
        const entries = await getStepOutput(run.id, index, lastSeq[index] ?? -1);
        dispatch({ type: "outputs.fetched", runId: run.id, stepIndex: index, entries });
      } catch (error) {
        console.warn(`[run-store] não foi possível ressincronizar a saída do passo ${index}`, error);
      }
    }),
  );
}

/** Mantém o estado do run ativo alimentado pelo WebSocket, ressincronizando a saída ao reconectar. */
export function RunStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    /** `true` entre uma queda da conexão e o `hello` seguinte. */
    let reconnected = false;
    return connectEvents(
      (event) => {
        // `lastSeq` é lido antes de aplicar o `hello`: ele troca o run e pode zerar a saída.
        const lastSeq = stateRef.current.run?.id === (event.type === "hello" ? event.activeRun?.id : undefined)
          ? stateRef.current.lastSeq
          : {};
        dispatch(event);
        if (event.type === "hello" && reconnected) {
          reconnected = false;
          if (event.activeRun) void resyncOutputs(event.activeRun, lastSeq, dispatch);
        }
      },
      (status) => {
        if (status === "reconnecting") reconnected = true;
        dispatch({ type: "connection", status });
      },
    );
  }, []);
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
