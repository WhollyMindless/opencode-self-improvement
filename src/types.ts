// Shared memory-row enums. Lives outside index.ts so the pure capture core
// (src/capture.ts) can reference the admissible values without importing the
// plugin entry. index.ts feeds these into the tool JSON Schemas; capture.ts
// uses them to prompt and validate.
export const TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const;
export const STATUSES = ["open", "settled"] as const;
