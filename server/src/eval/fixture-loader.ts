/**
 * Eval framework — fixture loader (Phase F2 utility, shared with F3 + F4).
 *
 * Each fixture is one JSON file inside the suite's `fixtures/` directory,
 * deserialised into an EvalCase. Files are loaded in lexicographic order so
 * the case numbering (01-* through 15-*) controls execution order — handy
 * when reading CI output top-down.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCase } from "./types.js";

export async function loadFixtures<TInput = unknown, TExpected = unknown>(
  dir: string,
): Promise<Array<EvalCase<TInput, TExpected>>> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(
    entries.map(async (file) => {
      const raw = await readFile(join(dir, file), "utf8");
      return JSON.parse(raw) as EvalCase<TInput, TExpected>;
    }),
  );
}
