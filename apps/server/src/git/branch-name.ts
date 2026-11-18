const SLUG_MAX = 40;
const pad = (value: number): string => String(value).padStart(2, "0");

/** `AAAAMMDD-HHmmss` no horário local. */
function timestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function slugify(description: string): string {
  const slug = description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "run";
}

/** `orchestrator/<AAAAMMDD-HHmmss>-<slug≤40>` (research R6, FR-004). */
export function buildRunBranchName(description: string, date: Date): string {
  return `orchestrator/${timestamp(date)}-${slugify(description)}`;
}
