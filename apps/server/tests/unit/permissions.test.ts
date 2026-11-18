import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, buildClaudeArgs, DISALLOWED_TOOLS } from "../../src/agent/permissions.js";
import { NON_INTERACTIVE_SYSTEM_PROMPT } from "../../src/agent/system-prompts.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const base = { prompt: "/speckit-plan", model: "opus", sessionId: SESSION, resume: false, interactive: false };

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
  it("gera a base com prompt, stream-json, modelo e acceptEdits", () => {
    const args = buildClaudeArgs(base);
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

  it("--allowedTools com as ferramentas de research R3", () => {
    expect(valuesAfter(buildClaudeArgs(base), "--allowedTools")).toEqual([
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

  it("--disallowedTools com cada comando git proibido nas formas Bash e PowerShell", () => {
    const denied = valuesAfter(buildClaudeArgs(base), "--disallowedTools");
    for (const cmd of FORBIDDEN) {
      expect(denied).toContain(`Bash(${cmd}:*)`);
      expect(denied).toContain(`PowerShell(${cmd}:*)`);
    }
    expect(denied).toHaveLength(FORBIDDEN.length * 2);
    expect(DISALLOWED_TOOLS).toEqual(denied);
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
