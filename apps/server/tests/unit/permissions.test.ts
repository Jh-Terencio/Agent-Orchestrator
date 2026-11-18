import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  buildClaudeArgs,
  DISALLOWED_TOOLS,
  PERMISSION_TOOL,
  YOLO_PERMISSION_MODE,
} from "../../src/agent/permissions.js";
import { relayCommand } from "../../src/agent/relay-path.js";
import { NON_INTERACTIVE_SYSTEM_PROMPT } from "../../src/agent/system-prompts.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const CHANNEL = { url: "http://127.0.0.1:4317/internal/permission-requests", token: "t".repeat(64) };
const RELAY = { command: "C:/node/node.exe", args: ["C:/app/permission-relay/relay.mjs"] };
/** Modo padrão (Yolo desligado): com canal de permissão. */
const base = {
  prompt: "/speckit-plan",
  model: "opus",
  sessionId: SESSION,
  resume: false,
  interactive: false,
  permissionChannel: CHANNEL,
};
const yolo = { ...base, permissionChannel: null };

/** Valores que seguem uma flag variádica até a próxima flag. */
function valuesAfter(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  expect(start).toBeGreaterThanOrEqual(0);
  const values: string[] = [];
  for (const arg of args.slice(start + 1)) {
    if (arg.startsWith("--")) break;
    values.push(arg);
  }
  return values;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

const FORBIDDEN = [
  "git push",
  "git merge",
  "git rebase",
  "git reset",
  "git commit",
  "git cherry-pick",
  "git revert",
  "git tag",
  "git branch -D",
  "git branch -d",
  "git update-ref",
];

describe("buildClaudeArgs", () => {
  it("gera a base com prompt, stream-json, modelo e acceptEdits (Yolo desligado)", () => {
    const args = buildClaudeArgs(base, RELAY);
    expect(args.slice(0, 2)).toEqual(["-p", "/speckit-plan"]);
    expect(valueAfter(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(valueAfter(args, "--model")).toBe("opus");
    expect(valueAfter(args, "--permission-mode")).toBe("acceptEdits");
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("sempre inclui as flags de isolamento (resume=%s, interactive=%s)", (resume, interactive) => {
    const args = buildClaudeArgs({ ...base, resume, interactive });
    expect(valueAfter(args, "--setting-sources")).toBe("project,local");
    expect(args).toContain("--strict-mcp-config");
  });

  it("--session-id quando resume = false", () => {
    const args = buildClaudeArgs({ ...base, resume: false });
    expect(valueAfter(args, "--session-id")).toBe(SESSION);
    expect(args).not.toContain("--resume");
  });

  it("--resume quando resume = true", () => {
    const args = buildClaudeArgs({ ...base, resume: true });
    expect(valueAfter(args, "--resume")).toBe(SESSION);
    expect(args).not.toContain("--session-id");
  });

  it("Yolo: --allowedTools com as ferramentas de research R3, inclusive Bash e PowerShell", () => {
    expect(valuesAfter(buildClaudeArgs(yolo), "--allowedTools")).toEqual([
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Skill",
      "TodoWrite",
      "Bash",
      "PowerShell",
    ]);
    expect(ALLOWED_TOOLS).toHaveLength(9);
  });

  it.each([
    ["Yolo", yolo],
    ["padrão", base],
  ])("--disallowedTools com cada comando git proibido nas formas Bash e PowerShell (%s)", (_mode, invocation) => {
    const denied = valuesAfter(buildClaudeArgs(invocation, RELAY), "--disallowedTools");
    for (const cmd of FORBIDDEN) {
      expect(denied).toContain(`Bash(${cmd}:*)`);
      expect(denied).toContain(`PowerShell(${cmd}:*)`);
    }
    expect(denied).toHaveLength(FORBIDDEN.length * 2);
    expect(DISALLOWED_TOOLS).toEqual(denied);
  });

  it("Yolo: permission-mode do Modo Yolo, sem canal MCP", () => {
    const args = buildClaudeArgs(yolo);
    expect(valueAfter(args, "--permission-mode")).toBe(YOLO_PERMISSION_MODE);
    expect(YOLO_PERMISSION_MODE).toBe("bypassPermissions");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--permission-prompt-tool");
    expect(args).toContain("--strict-mcp-config");
  });

  it("padrão: --allowedTools sem Bash/PowerShell e pedidos pela ferramenta do relay", () => {
    const args = buildClaudeArgs(base, RELAY);
    const allowed = valuesAfter(args, "--allowedTools");
    expect(allowed).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Skill", "TodoWrite"]);
    expect(valueAfter(args, "--permission-prompt-tool")).toBe(PERMISSION_TOOL);
    expect(PERMISSION_TOOL).toBe("mcp__orchestrator__approve");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(valueAfter(args, "--mcp-config") ?? "null")).toEqual({
      mcpServers: {
        orchestrator: {
          command: RELAY.command,
          args: RELAY.args,
          env: { ORCHESTRATOR_PERMISSION_URL: CHANNEL.url, ORCHESTRATOR_PERMISSION_TOKEN: CHANNEL.token },
        },
      },
    });
  });

  it("padrão sem relay explícito usa relayCommand()", () => {
    const config = JSON.parse(valueAfter(buildClaudeArgs(base), "--mcp-config") ?? "null") as {
      mcpServers: { orchestrator: { command: string; args: string[] } };
    };
    expect(config.mcpServers.orchestrator.command).toBe(relayCommand().command);
    expect(config.mcpServers.orchestrator.args).toEqual(relayCommand().args);
  });

  it("--append-system-prompt se e somente se não interativo", () => {
    const nonInteractive = buildClaudeArgs({ ...base, interactive: false });
    expect(valueAfter(nonInteractive, "--append-system-prompt")).toBe(NON_INTERACTIVE_SYSTEM_PROMPT);
    expect(buildClaudeArgs({ ...base, interactive: true })).not.toContain("--append-system-prompt");
    expect(buildClaudeArgs({ ...base, interactive: true, resume: true })).not.toContain("--append-system-prompt");
  });

  it("o prompt com texto livre vai como um único argumento (sem shell)", () => {
    const prompt = '/speckit-specify Login com "aspas" && rm -rf / ; echo $HOME';
    expect(buildClaudeArgs({ ...base, prompt })[1]).toBe(prompt);
  });
});
