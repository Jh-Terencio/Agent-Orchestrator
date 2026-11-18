import { describe, expect, it } from "vitest";
import { isAllowedHost, isAllowedOrigin } from "../../src/http/origin-guard.js";

describe("isAllowedOrigin", () => {
  it("aceita ausência de Origin", () => {
    expect(isAllowedOrigin(undefined, 4317, [])).toBe(true);
  });

  it("aceita 127.0.0.1 e localhost na porta do servidor", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4317", 4317, [])).toBe(true);
    expect(isAllowedOrigin("http://localhost:4317", 4317, [])).toBe(true);
  });

  it("aceita a porta do Vite em dev", () => {
    expect(isAllowedOrigin("http://localhost:5173", 4317, [5173])).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", 4317, [])).toBe(false);
  });

  it("recusa outras origens, portas, esquemas e 'null'", () => {
    expect(isAllowedOrigin("http://evil.example", 4317, [])).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:9999", 4317, [])).toBe(false);
    expect(isAllowedOrigin("https://127.0.0.1:4317", 4317, [])).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1.evil.example:4317", 4317, [])).toBe(false);
    expect(isAllowedOrigin("null", 4317, [])).toBe(false);
  });
});

describe("isAllowedHost", () => {
  it("aceita 127.0.0.1 e localhost na porta do servidor", () => {
    expect(isAllowedHost("127.0.0.1:4317", 4317)).toBe(true);
    expect(isAllowedHost("localhost:4317", 4317)).toBe(true);
  });

  it("recusa outros hosts, portas ou ausência", () => {
    expect(isAllowedHost("evil.example:4317", 4317)).toBe(false);
    expect(isAllowedHost("127.0.0.1:80", 4317)).toBe(false);
    expect(isAllowedHost(undefined, 4317)).toBe(false);
  });
});
