import { describe, expect, it } from "vitest";
import { deriveRule, matchesRule, summarizeToolInput } from "../src/permission-rules.js";

describe("deriveRule", () => {
  it("usa os dois primeiros tokens do comando de shell", () => {
    expect(deriveRule("Bash", { command: "npm test -- --run" })).toBe("Bash(npm test:*)");
    expect(deriveRule("PowerShell", { command: "Get-ChildItem -Recurse" })).toBe("PowerShell(Get-ChildItem -Recurse:*)");
  });

  it("usa só um token quando o comando tem um", () => {
    expect(deriveRule("Bash", { command: "  make  " })).toBe("Bash(make:*)");
  });

  it("usa o nome da ferramenta fora do shell", () => {
    expect(deriveRule("WebFetch", { url: "https://x" })).toBe("WebFetch");
  });

  it("usa o nome da ferramenta quando o shell não tem comando", () => {
    expect(deriveRule("Bash", {})).toBe("Bash");
  });
});

describe("matchesRule", () => {
  it("casa o prefixo seguido de espaço ou o comando exato", () => {
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm test -- --watch=false" })).toBe(true);
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "  npm test  " })).toBe(true);
  });

  it("não casa um prefixo sem separador", () => {
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm testx" })).toBe(false);
  });

  it("não casa outra ferramenta", () => {
    expect(matchesRule("Bash(npm test:*)", "PowerShell", { command: "npm test" })).toBe(false);
  });

  it.each(["npm test; rm -rf /", "npm test && rm x", "npm test || x", "npm test | tee", "npm test `x`", "npm test $(x)", "npm test\nrm x"])(
    "nunca casa comandos com separadores de shell: %j",
    (command) => {
      expect(matchesRule("Bash(npm test:*)", "Bash", { command })).toBe(false);
    },
  );

  it("casa regra de ferramenta pelo nome", () => {
    expect(matchesRule("WebFetch", "WebFetch", { url: "https://y" })).toBe(true);
    expect(matchesRule("WebFetch", "WebSearch", { query: "y" })).toBe(false);
  });

  it("regra de shell sem comando não casa", () => {
    expect(matchesRule("Bash(npm test:*)", "Bash", {})).toBe(false);
  });
});

describe("summarizeToolInput", () => {
  it("usa o campo mais informativo da entrada", () => {
    expect(summarizeToolInput({ command: "npm test", description: "roda" })).toBe("npm test");
    expect(summarizeToolInput({ url: "https://x" })).toBe("https://x");
    expect(summarizeToolInput("x")).toBe("");
  });
});
