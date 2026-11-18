import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_NOT_FOUND_MESSAGE, resolveClaudeCommand, type ResolveClaudeDeps } from "../../src/agent/resolve-claude.js";

const NPM_DIR = "C:\\Users\\u\\AppData\\Roaming\\npm";
const LOCAL_BIN = "C:\\Users\\u\\.local\\bin";
const CLI_JS = win32.join(NPM_DIR, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
const NPM_SHIM = `@ECHO off
SETLOCAL
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

function deps(files: Record<string, string>, overrides: Partial<ResolveClaudeDeps> = {}): ResolveClaudeDeps {
  return {
    platform: "win32",
    pathEnv: [LOCAL_BIN, NPM_DIR].join(";"),
    pathExt: ".COM;.EXE;.BAT;.CMD",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    exists: (path) => path in files,
    readFile: (path) => files[path] ?? null,
    ...overrides,
  };
}

describe("resolveClaudeCommand", () => {
  it("win32 com claude.exe e claude.cmd → usa claude.exe", () => {
    const result = resolveClaudeCommand(
      deps({
        [win32.join(NPM_DIR, "claude.cmd")]: NPM_SHIM,
        [CLI_JS]: "",
        [win32.join(LOCAL_BIN, "claude.exe")]: "",
      }, { pathEnv: [NPM_DIR, LOCAL_BIN].join(";") }),
    );
    expect(result).toEqual({ command: win32.join(LOCAL_BIN, "claude.exe"), prefixArgs: [] });
  });

  it("win32 só com claude.cmd e cli.js existente → node + cli.js", () => {
    const result = resolveClaudeCommand(deps({ [win32.join(NPM_DIR, "claude.cmd")]: NPM_SHIM, [CLI_JS]: "" }));
    expect(result).toEqual({ command: "C:\\Program Files\\nodejs\\node.exe", prefixArgs: [CLI_JS] });
  });

  it("win32 com claude.cmd sem cli.js → erro de cli.js", () => {
    const result = resolveClaudeCommand(deps({ [win32.join(NPM_DIR, "claude.cmd")]: NPM_SHIM }));
    expect(result).toEqual({
      error:
        "Encontrei claude.cmd, mas não consegui localizar o cli.js do Claude Code. Reinstale com o instalador nativo (claude.exe).",
    });
  });

  it("win32 sem nenhum → erro 'não encontrado no PATH'", () => {
    const result = resolveClaudeCommand(deps({}));
    expect(result).toEqual({ error: CLAUDE_NOT_FOUND_MESSAGE });
    expect(CLAUDE_NOT_FOUND_MESSAGE).toContain("não encontrado no PATH");
  });

  it("POSIX → claude", () => {
    expect(resolveClaudeCommand(deps({}, { platform: "linux", pathEnv: "/usr/bin" }))).toEqual({
      command: "claude",
      prefixArgs: [],
    });
    expect(resolveClaudeCommand(deps({}, { platform: "darwin", pathEnv: "/usr/bin" }))).toEqual({
      command: "claude",
      prefixArgs: [],
    });
  });

  it("nenhum caso retorna opção de shell", () => {
    const cases = [
      deps({ [win32.join(LOCAL_BIN, "claude.exe")]: "" }),
      deps({ [win32.join(NPM_DIR, "claude.cmd")]: NPM_SHIM, [CLI_JS]: "" }),
      deps({}),
      deps({}, { platform: "linux" }),
    ];
    for (const item of cases) {
      const result = resolveClaudeCommand(item);
      expect(Object.keys(result).sort()).toEqual("error" in result ? ["error"] : ["command", "prefixArgs"]);
      if ("command" in result) expect(result.command).not.toMatch(/\.(cmd|bat)$/i);
    }
  });
});
