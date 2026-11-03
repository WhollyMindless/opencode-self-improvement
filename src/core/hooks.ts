// Fail-soft wrapper for plugin bookkeeping hooks (#168).
export async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[opencode-self-improvement] ${name} hook failed (ignored):`, err);
  }
}

