// Sanitiza as capturas brutas (T043). Uso: node sanitize.mjs <rawDir> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [rawDir, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const ids = new Map();
let counter = 0;
const fakeUuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};
const mapId = (value, make) => {
  if (!ids.has(value)) ids.set(value, make());
  return ids.get(value);
};
let idCounter = 0;
const fakeOpaque = (prefix) => () => `${prefix}${String(++idCounter).padStart(20, "0")}`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REPO = /[A-Za-z]:\\Users\\[^\\"]+\\AppData\\Local\\Temp\\fixture-repo-[A-Za-z0-9]+/g;
const HOME = /[A-Za-z]:\\Users\\[^\\"]+/g;

function cleanString(s) {
  s = s.replace(REPO, "/repo").replace(HOME, "/home/user");
  if (s.startsWith("/repo") || s.startsWith("/home/user")) s = s.replace(/\\/g, "/");
  s = s.replace(UUID, (m) => mapId(m.toLowerCase(), fakeUuid));
  s = s.replace(/\b(msg|req|toolu)_[A-Za-z0-9]+/g, (m, p) => mapId(m, fakeOpaque(`${p}_fixture`)));
  return s;
}

const DROP = new Set(["memory_paths", "messaging_socket_path", "powershell_path", "credential_expires_at"]);

function walk(value) {
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (DROP.has(key)) continue;
      out[cleanString(key)] = walk(v);
    }
    return out;
  }
  return value;
}

function sanitizeEvent(event) {
  const e = walk(event);
  if (e.type === "rate_limit_event") {
    e.rate_limit_info = { status: "allowed", resetsAt: 1800000000, rateLimitType: "five_hour", isUsingOverage: false };
  }
  return e;
}

for (const name of ["success", "resume", "question-ending", "error-result", "auth-error"]) {
  const raw = readFileSync(join(rawDir, `${name}.jsonl`), "utf8");
  const events = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  // Remonta os fragmentos input_json_delta de cada bloco, sanitiza o JSON inteiro e redistribui.
  const groups = new Map();
  for (const e of events) {
    if (e.type === "stream_event" && e.event?.delta?.type === "input_json_delta") {
      const key = `${e.api_message_id}:${e.event.index}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
  }
  for (const group of groups.values()) {
    const joined = group.map((e) => e.event.delta.partial_json).join("");
    const clean = JSON.stringify(walk(JSON.parse(joined)));
    const size = Math.ceil(clean.length / group.length);
    group.forEach((e, i) => (e.event.delta.partial_json = clean.slice(i * size, (i + 1) * size)));
  }
  const out = events.map((event) => JSON.stringify(sanitizeEvent(event))).join("\n");
  writeFileSync(join(outDir, `${name}.jsonl`), `${out}\n`, "utf8");
}
console.log("ids mapeados:", ids.size);
