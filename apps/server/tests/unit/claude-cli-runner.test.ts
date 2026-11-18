import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInvocation } from "../../src/agent/agent-runner.js";
import { ClaudeCliRunner } from "../../src/agent/claude-cli-runner.js";

const execFileAsync = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orchestrator-runner-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const INIT_LINE = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "sonnet" });
const TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
});

/** Grava um script `node` que faz o papel do binário `claude` e devolve o runner que o executa. */
async function fakeBinary(body: string): Promise<ClaudeCliRunner> {
  const script = join(dir, "fake-claude.mjs");
  await writeFile(script, body, "utf8");
  return new ClaudeCliRunner({ resolveCommand: () => ({ command: process.execPath, prefixArgs: [script] }) });
}

function invocation(signal: AbortSignal, outputs: string[]): AgentInvocation {
  return {
    cwd: dir,
    prompt: "/speckit-specify algo",
    model: "sonnet",
    sessionId: "00000000-0000-4000-8000-000000000001",
    resume: false,
    interactive: false,
    priorSessionCostUsd: 0,
    permissionChannel: null,
    signal,
    onOutput: (entry) => outputs.push(entry.text),
  };
}

async function isAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      windowsHide: true,
    });
    return stdout.includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("tempo esgotado esperando a condição");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("ClaudeCliRunner: interrupção (US3)", () => {
  it("abortar o signal resolve interrupted em < 5 s, mata o processo e não repassa saída depois", async () => {
    const pidFile = join(dir, "fake.pid");
    const runner = await fakeBinary(
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.stdout.write(${JSON.stringify(INIT_LINE + "\n")});`,
        `setInterval(() => process.stdout.write(${JSON.stringify(TOOL_LINE + "\n")}), 50);`,
        "",
      ].join("\n"),
    );
    const outputs: string[] = [];
    const controller = new AbortController();
    const pending = runner.run(invocation(controller.signal, outputs));

    await waitUntil(() => outputs.length >= 2);
    const pid = Number((await readFile(pidFile, "utf8")).trim());

    const abortedAt = Date.now();
    controller.abort("user");
    const outcome = await pending;
    expect(outcome.kind).toBe("interrupted");
    expect(Date.now() - abortedAt).toBeLessThan(5000);

    const count = outputs.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(outputs.length).toBe(count);
    await waitUntil(async () => !(await isAlive(pid)), 3000);
  }, 15_000);

  it("signal já abortado antes do spawn → interrupted sem iniciar o processo", async () => {
    const marker = join(dir, "started.txt");
    const runner = await fakeBinary(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    const controller = new AbortController();
    controller.abort("user");
    const outcome = await runner.run(invocation(controller.signal, []));
    expect(outcome.kind).toBe("interrupted");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});

describe("ClaudeCliRunner: erros", () => {
  it("sai com código 1 sem result → error com o fim do stderr", async () => {
    const runner = await fakeBinary(
      `process.stderr.write("linha 1\\nfalha catastrófica\\n");\nprocess.exit(1);\n`,
    );
    const outcome = await runner.run(invocation(new AbortController().signal, []));
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("código 1");
    expect(outcome.message).toContain("falha catastrófica");
  });

  it("comando inexistente → error de não encontrado no PATH", async () => {
    const runner = new ClaudeCliRunner({
      resolveCommand: () => ({ command: join(dir, "nao-existe-claude"), prefixArgs: [] }),
    });
    const outcome = await runner.run(invocation(new AbortController().signal, []));
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.message).toContain("não encontrado no PATH");
  });
});
