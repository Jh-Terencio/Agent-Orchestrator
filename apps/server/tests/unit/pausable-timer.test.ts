import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPausableTimer } from "../../src/execution/pausable-timer.js";

describe("createPausableTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispara depois do tempo total sem pausa", () => {
    const onFire = vi.fn();
    createPausableTimer(10_000, onFire);
    vi.advanceTimersByTime(9_999);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("a pausa não conta: retoma com o tempo restante", () => {
    const onFire = vi.fn();
    const timer = createPausableTimer(10_000, onFire);
    vi.advanceTimersByTime(4_000);
    timer.pause();
    expect(timer.remainingMs()).toBe(6_000);
    vi.advanceTimersByTime(60_000);
    expect(onFire).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(5_999);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("pause e resume repetidos são idempotentes", () => {
    const onFire = vi.fn();
    const timer = createPausableTimer(1_000, onFire);
    timer.pause();
    timer.pause();
    vi.advanceTimersByTime(5_000);
    timer.resume();
    timer.resume();
    vi.advanceTimersByTime(1_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("clear impede o disparo, inclusive depois de resume", () => {
    const onFire = vi.fn();
    const timer = createPausableTimer(1_000, onFire);
    timer.clear();
    vi.advanceTimersByTime(5_000);
    timer.resume();
    vi.advanceTimersByTime(5_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});
