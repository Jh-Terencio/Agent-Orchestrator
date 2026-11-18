import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killProcessTree } from "../../src/agent/kill-tree.js";

const execFileAsync = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orchestrator-kill-tree-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** `true` se o processo ainda existe (Windows: `tasklist`; POSIX: sinal 0). */
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

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

describe("killProcessTree", () => {
  it("encerra o processo pai e o filho em < 5 s", async () => {
    const pidFile = join(dir, "child.pid");
    const childScript = join(dir, "child.mjs");
    const parentScript = join(dir, "parent.mjs");
    await writeFile(childScript, "setInterval(() => {}, 1000);\n", "utf8");
    await writeFile(
      parentScript,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const parent = spawn(process.execPath, [parentScript], {
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const parentPid = parent.pid!;
    const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));

    const childPid = await waitFor(async () => {
      try {
        return (await readFile(pidFile, "utf8")).trim().length > 0;
      } catch {
        return false;
      }
    }, 5000).then(async (ok) => {
      expect(ok).toBe(true);
      return Number((await readFile(pidFile, "utf8")).trim());
    });
    expect(await isAlive(parentPid)).toBe(true);
    expect(await isAlive(childPid)).toBe(true);

    const startedAt = Date.now();
    await killProcessTree(parentPid);
    await exited;
    const childGone = await waitFor(async () => !(await isAlive(childPid)), 5000);
    expect(childGone).toBe(true);
    expect(await isAlive(parentPid)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  }, 15_000);

  it("ignora processo já encerrado", async () => {
    const done = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    await new Promise<void>((resolve) => done.once("exit", () => resolve()));
    await expect(killProcessTree(done.pid!)).resolves.toBeUndefined();
  });
});
