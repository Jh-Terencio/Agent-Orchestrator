import { describe, expect, it } from "vitest";
import { computeRunTotals } from "../src/run-totals.js";
import type { Usage } from "../src/schemas/run.js";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    numTurns: null,
    ...overrides,
  };
}

function runWith(steps: { durationMs: number | null; usage: Usage | null }[]) {
  return { steps };
}

describe("computeRunTotals", () => {
  it("soma durationMs ignorando nulos", () => {
    const totals = computeRunTotals(
      runWith([
        { durationMs: 1000, usage: null },
        { durationMs: null, usage: null },
        { durationMs: 2500, usage: null },
      ]),
    );
    expect(totals.durationMs).toBe(3500);
  });

  it("retorna durationMs null se nenhum passo tiver duração", () => {
    const totals = computeRunTotals(
      runWith([
        { durationMs: null, usage: null },
        { durationMs: null, usage: null },
      ]),
    );
    expect(totals.durationMs).toBeNull();
  });

  it("soma usage campo a campo, com null nos campos que nenhum passo reportou", () => {
    const totals = computeRunTotals(
      runWith([
        { durationMs: 1, usage: usage({ inputTokens: 100, outputTokens: 10, costUsd: 0.13 }) },
        { durationMs: 1, usage: null },
        { durationMs: 1, usage: usage({ inputTokens: 50, costUsd: 0.007, numTurns: 2 }) },
      ]),
    );
    expect(totals.usage).not.toBeNull();
    expect(totals.usage?.inputTokens).toBe(150);
    expect(totals.usage?.outputTokens).toBe(10);
    expect(totals.usage?.costUsd).toBeCloseTo(0.137, 10);
    expect(totals.usage?.numTurns).toBe(2);
    expect(totals.usage?.cacheReadTokens).toBeNull();
    expect(totals.usage?.cacheCreationTokens).toBeNull();
  });

  it("retorna usage null se nenhum passo tiver usage", () => {
    const totals = computeRunTotals(
      runWith([
        { durationMs: 10, usage: null },
        { durationMs: 20, usage: null },
      ]),
    );
    expect(totals).toEqual({ durationMs: 30, usage: null });
  });

  it("run sem passos iniciados → { durationMs: null, usage: null }", () => {
    expect(
      computeRunTotals(
        runWith([
          { durationMs: null, usage: null },
          { durationMs: null, usage: null },
        ]),
      ),
    ).toEqual({ durationMs: null, usage: null });
    expect(computeRunTotals(runWith([]))).toEqual({ durationMs: null, usage: null });
  });
});
