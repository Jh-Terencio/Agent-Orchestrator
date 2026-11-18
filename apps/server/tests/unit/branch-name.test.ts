import { describe, expect, it } from "vitest";
import { buildRunBranchName } from "../../src/git/branch-name.js";

// 2026-11-17 09:05:07 no horário local
const date = new Date(2026, 10, 17, 9, 5, 7);

describe("buildRunBranchName", () => {
  it("gera orchestrator/<AAAAMMDD-HHmmss>-<slug>", () => {
    expect(buildRunBranchName("Adicionar login", date)).toBe("orchestrator/20261117-090507-adicionar-login");
  });

  it("remove acentos e troca não alfanuméricos por hífen, colapsando hífens", () => {
    expect(buildRunBranchName("Criação de relatório: período/mês!!", date)).toBe(
      "orchestrator/20261117-090507-criacao-de-relatorio-periodo-mes",
    );
  });

  it("limita o slug a 40 caracteres e não termina em hífen", () => {
    const name = buildRunBranchName("a".repeat(39) + " bbbbbb", date);
    const slug = name.replace("orchestrator/20261117-090507-", "");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe("a".repeat(39));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("não começa nem termina com hífen", () => {
    expect(buildRunBranchName("  --Olá mundo--  ", date)).toBe("orchestrator/20261117-090507-ola-mundo");
  });

  it("usa 'run' quando a descrição não tem caracteres válidos", () => {
    expect(buildRunBranchName("!!! ??? ###", date)).toBe("orchestrator/20261117-090507-run");
    expect(buildRunBranchName("日本語", date)).toBe("orchestrator/20261117-090507-run");
  });
});
