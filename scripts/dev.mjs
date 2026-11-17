// Runs the server and web dev scripts in parallel (no extra dependency).
// Ctrl+C stops both; if one exits, the other is stopped too.
import { spawn } from "node:child_process";

const children = ["apps/server", "apps/web"].map((workspace) =>
  spawn("npm", ["run", "dev", "-w", workspace], { stdio: "inherit", shell: true }),
);

let exiting = false;
function stopAll(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

for (const child of children) child.on("exit", (code) => stopAll(code ?? 0));
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
