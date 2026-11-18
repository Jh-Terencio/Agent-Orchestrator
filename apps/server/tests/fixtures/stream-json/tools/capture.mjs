// Captura bruta das fixtures stream-json (T043). Uso, na raiz do repo: npx tsx apps/server/tests/fixtures/stream-json/tools/capture.mjs <pastaForaDoRepo>
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeArgs } from "../../../../src/agent/permissions.ts";

const outDir = process.argv[2];
mkdirSync(outDir, { recursive: true });

const repo = mkdtempSync(join(tmpdir(), "fixture-repo-"));
const git = (...a) => execFileSync("git", a, { cwd: repo });
git("init", "-b", "main");
git("config", "user.name", "x");
git("config", "user.email", "x@example.invalid");
writeFileSync(join(repo, "README.md"), "# Projeto de exemplo\n\nEste repositório é só um exemplo de configuração.\n");
git("add", "-A");
git("commit", "-m", "init");

function run(name, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => {
      writeFileSync(join(outDir, `${name}.jsonl`), Buffer.concat(out));
      writeFileSync(join(outDir, `${name}.stderr.txt`), `exit=${code}\n${Buffer.concat(err).toString("utf8")}`);
      console.log(name, "exit", code);
      resolve();
    });
  });
}

const session = randomUUID();
const base = { model: "haiku", interactive: false };

await run("success", buildClaudeArgs({
  ...base, sessionId: session, resume: false,
  prompt: "Use a ferramenta Read para ler README.md e responda em uma frase curta, em português, o que o arquivo diz.",
}));
await run("resume", buildClaudeArgs({
  ...base, sessionId: session, resume: true, interactive: true,
  prompt: "Agora responda apenas: é isso, concluído.",
}));
await run("question-ending", buildClaudeArgs({
  ...base, sessionId: randomUUID(), resume: false, interactive: true,
  prompt: "Não use ferramentas. Faça-me uma única pergunta curta sobre qual nome devo dar à feature e termine a resposta com a pergunta.",
}));
await run("error-result", buildClaudeArgs({
  ...base, model: "modelo-que-nao-existe", sessionId: randomUUID(), resume: false,
  prompt: "Diga oi.",
}));
const emptyConfig = mkdtempSync(join(tmpdir(), "claude-noauth-"));
const env = { ...process.env, CLAUDE_CONFIG_DIR: emptyConfig };
delete env.ANTHROPIC_API_KEY;
delete env.CLAUDE_CODE_OAUTH_TOKEN;
await run("auth-error", buildClaudeArgs({ ...base, sessionId: randomUUID(), resume: false, prompt: "Diga oi." }), env);
console.log("repo:", repo);
