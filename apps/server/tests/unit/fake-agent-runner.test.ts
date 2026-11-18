import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInvocation } from "../../src/agent/agent-runner.js";
import { FakeAgentRunner } from "../fakes/fake-agent-runner.js";

function invocation(signal: AbortSignal, onOutput: AgentInvocation["onOutput"] = () => undefined): AgentInvocation {
  return {
    cwd: "/repo",
    prompt: "/speckit-specify algo",
    model: "sonnet",
    sessionId: "11111111-1111-4111-8111-111111111111",
    resume: false,
    interactive: false,
    priorSessionCostUsd: 0,
    permissionChannel: null,
    signal,
    onOutput,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FakeAgentRunner", () => {
  it("emite saída, roda sideEffect, registra a invocação e resolve com o resultado configurado", async () => {
    const sideEffect = vi.fn(async () => undefined);
    const runner = new FakeAgentRunner([
      { outputs: [{ kind: "text", text: "olá" }], sideEffect, sessionCostUsd: 0.5, result: "error", errorMessage: "x" },
    ]);
    const outputs: string[] = [];
    const outcome = await runner.run(invocation(new AbortController().signal, (entry) => outputs.push(entry.text)));
    expect(outputs).toEqual(["olá"]);
    expect(sideEffect).toHaveBeenCalledWith("/repo");
    expect(outcome).toMatchObject({ kind: "error", message: "x", sessionCostUsd: 0.5 });
    expect(runner.invocations[0]).toMatchObject({ prompt: "/speckit-specify algo", model: "sonnet", resume: false });
  });

  it("respeita o atraso com fake timers e resolve interrupted ao abortar, ainda rodando o sideEffect", async () => {
    vi.useFakeTimers();
    const sideEffect = vi.fn(async () => undefined);
    const runner = new FakeAgentRunner([{ delayMs: 10_000, sideEffect }]);
    const controller = new AbortController();
    const pending = runner.run(invocation(controller.signal));
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort("user");
    const outcome = await pending;
    expect(outcome.kind).toBe("interrupted");
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it("resolve success depois do atraso", async () => {
    vi.useFakeTimers();
    const runner = new FakeAgentRunner([{ delayMs: 1_000 }]);
    let done = false;
    const pending = runner.run(invocation(new AbortController().signal)).then((outcome) => {
      done = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).kind).toBe("success");
  });
});
