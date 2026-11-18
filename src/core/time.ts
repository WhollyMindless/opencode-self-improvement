// time — split from src/config.ts. Declaration bodies are unchanged.

export function dateStr(d: Date = new Date()): string {
  return d.toISOString().split("T")[0];
}
