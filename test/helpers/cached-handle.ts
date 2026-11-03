// Shared interception for tests that pin readers against Bun's cached
// `Bun.file` metadata. Runtime premise (recorded once, here): a BunFile
// caches its size when it is created, so a handle opened before an atomic
// rename still reports — and `text()` returns — the pre-replacement length
// even though the path now holds a larger file. Only the factory is
// intercepted: the cached handle reads real replacement bytes with genuinely
// stale metadata, and every unrelated path uses real Bun.file. The executable
// pin for this premise is "Bun cached-size premise" in
// complete-store-reads.test.ts; when Bun fixes the cache that test goes red
// first — re-audit the readers and their negative controls instead of letting
// this seam go vacuous.
import { expect, spyOn } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Write `before`, open the handle whose metadata will go stale, atomically
// replace the file with `text`, then intercept `Bun.file(file)` so readers
// under test receive the stale handle. Returns the restore function; the
// caller owns it (finally block or afterEach).
export async function replaceWithCachedHandle(
  file: string,
  text: string,
  before = "short\n",
): Promise<() => void> {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, before);
  const cached = Bun.file(file);
  expect(await cached.exists()).toBe(true);
  writeFileSync(`${file}.next`, text);
  renameSync(`${file}.next`, file);
  const real = Bun.file;
  const spy = spyOn(Bun, "file").mockImplementation(
    (path: unknown, options?: BlobPropertyBag) =>
      path === file ? cached : Reflect.apply(real, Bun, [path, options]),
  );
  return () => spy.mockRestore();
}
