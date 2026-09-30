/**
 * Memory Keeper extraction eval suite (Phase F3, T10).
 *
 * Loads fixture threads and asks an LLM to extract the same memory
 * candidates the Memory Keeper agent would: decisions, tasks, insights,
 * context, references, preferences. The real Memory Keeper delegates to
 * `extractMemoryCandidates` (services/extraction.ts:800), so this suite
 * invokes that pure function directly — wired through an injected
 * `ExtractionLlm` that calls OpenAI via fetch and a minimal in-memory
 * db stub that returns fixture entries.
 *
 * Why a stub db rather than vi.mocking extraction.ts itself: the suite is
 * meant to lock in the *prompt + parsing contract*, not just the grading
 * shape. Driving the real `extractMemoryCandidates` makes the suite catch
 * regressions in the prompt template, the JSON cleaner, the type
 * validator, and the candidate-mapping shape — all silently — when those
 * change. The stub surface is intentionally tiny (two select shapes) so
 * it stays cheap to maintain.
 *
 * Future prompt + extractor changes should be reflected in fixtures so
 * the suite stays tied to the agent it audits.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@armyofagents/db";
import {
  extractMemoryCandidates,
  type ExtractionLlm,
  type MemoryCandidate,
} from "../../services/extraction.js";
import type { EvalGrade, EvalSuite } from "../types.js";
import { loadFixtures } from "../fixture-loader.js";
import { gradeWithRubric, type LlmGraderConfig } from "../llm-grader.js";

const EXTRACTION_MODEL = "gpt-4o-mini";

/**
 * Fixture input shape. Each fixture is one synthetic thread plus its
 * entries — no real DB row needed. `companyId` is just a tag passed
 * through to the extractor; the stub db doesn't filter on it.
 */
export interface MemoryKeeperFixtureInput {
  thread: {
    id: string;
    companyId: string;
    entries: Array<{ id: string; rawContent: string; createdAt: string }>;
  };
}

export interface MemoryKeeperSuiteConfig {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  fixturesDir?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build a minimal db stub that satisfies the two `select` shapes
 * `extractMemoryCandidates` issues — entries-by-discussion (with orderBy)
 * and projects-by-company (no orderBy). Returns the fixture entries on
 * the first await and an empty projects list on the second.
 *
 * The stub honors the call shape `extractMemoryCandidates` uses:
 *   1. db.select({...}).from(discussionEntries).where(...).orderBy(...)
 *   2. db.select({...}).from(projects).where(...)
 *
 * We don't inspect the predicates — fixtures don't pass `sinceEntryId`,
 * so the cursor path stays out of the way and we never need to support
 * the optional initial `where().select()` round-trip the cursor branch
 * takes. If a future fixture needs the cursor path, extend this stub
 * with a third queued row set.
 */
function makeStubDb(
  entries: MemoryKeeperFixtureInput["thread"]["entries"],
): Db {
  // Drizzle issues three awaits in the allowed-extraction path:
  //   1. discussions privacy gate (allowMemoryExtraction lookup, added 2026-05-29)
  //   2. entries fetch (with orderBy)
  //   3. projects fetch (no orderBy) — buildDepartmentsList
  // We return one queued row set per await regardless of orderBy presence —
  // both arms of the chain are thenable so either await resolves.
  const queue: unknown[][] = [
    [{ allowMemoryExtraction: true }], // discussions gate — fixtures always allow
    entries.map((e) => ({
      id: e.id,
      rawContent: e.rawContent,
      createdAt: new Date(e.createdAt),
    })),
    [], // projects — empty so buildDepartmentsList emits the "(none configured)" string
  ];

  function chain(): {
    from: () => ReturnType<typeof chain>;
    where: () => ReturnType<typeof chain>;
    orderBy: () => ReturnType<typeof chain>;
    then: (fn: (rows: unknown[]) => unknown) => Promise<unknown>;
  } {
    const c = {
      from: () => c,
      where: () => c,
      orderBy: () => c,
      then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(queue.shift() ?? [])),
    };
    return c;
  }

  return {
    select: () => chain(),
  } as unknown as Db;
}

export async function buildMemoryKeeperSuite(
  config: MemoryKeeperSuiteConfig = {},
): Promise<EvalSuite<MemoryKeeperFixtureInput, MemoryCandidate[], unknown>> {
  const fixturesDir = config.fixturesDir ?? join(__dirname, "fixtures");
  const cases = await loadFixtures<MemoryKeeperFixtureInput, unknown>(fixturesDir);
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const model = config.model ?? EXTRACTION_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const graderConfig: LlmGraderConfig = { apiKey, fetchImpl };

  return {
    name: "memory-keeper-extraction",
    cases,
    concurrency: 5,
    async runOne(input) {
      if (!apiKey) {
        throw new Error("no OPENAI_API_KEY configured");
      }
      const llm: ExtractionLlm = {
        async generate(systemPrompt, userContent) {
          const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent },
              ],
              response_format: { type: "json_object" },
              temperature: 0,
            }),
          });
          if (!response.ok) {
            const body = await response.text().catch(() => "<no body>");
            throw new Error(
              `Memory Keeper extractor fetch failed ${response.status}: ${body.slice(0, 200)}`,
            );
          }
          const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string | null } }>;
          };
          const content = data.choices?.[0]?.message?.content;
          if (!content) throw new Error("extractor returned empty content");
          // The Memory Keeper prompt asks for a JSON array. OpenAI's
          // response_format: json_object wraps the array in an object — be
          // tolerant of both shapes: either `[...]` directly, or
          // `{items: [...]}` / `{candidates: [...]}` / similar. parseExtractedItems
          // then validates the inner array.
          const trimmed = content.trim();
          if (trimmed.startsWith("[")) return trimmed;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            for (const key of ["items", "candidates", "extracted", "data", "results"]) {
              const v = parsed[key];
              if (Array.isArray(v)) return JSON.stringify(v);
            }
            // Last resort: find the first array-valued property.
            for (const v of Object.values(parsed)) {
              if (Array.isArray(v)) return JSON.stringify(v);
            }
          } catch {
            // Fall through — let parseExtractedItems surface the parse error.
          }
          return trimmed;
        },
      };

      const stubDb = makeStubDb(input.thread.entries);
      const { candidates } = await extractMemoryCandidates(stubDb, llm, {
        companyId: input.thread.companyId,
        threadId: input.thread.id,
      });
      return candidates;
    },
    async grade(actual, expected): Promise<EvalGrade> {
      if (expected.type === "exact") {
        // expected.value MUST be { types: string[] } — the contract is "what
        // types were extracted", order-agnostic but count-aware.
        const expectedTypes = Array.isArray(
          (expected.value as { types?: unknown }).types,
        )
          ? ((expected.value as { types: string[] }).types ?? []).slice().sort()
          : null;
        if (!expectedTypes) {
          return {
            pass: false,
            score: 0,
            reason: "exact grading requires expected.value.types: string[]",
          };
        }
        const actualTypes = actual.map((c) => c.type).sort();
        const pass =
          actualTypes.length === expectedTypes.length &&
          actualTypes.every((t, i) => t === expectedTypes[i]);
        return {
          pass,
          score: pass ? 1 : 0,
          reason: pass
            ? `types matched (${actualTypes.join(", ") || "empty"})`
            : `expected [${expectedTypes.join(", ")}], got [${actualTypes.join(", ")}]`,
        };
      }
      if (expected.type === "llm-graded") {
        return gradeWithRubric(
          actual,
          expected as { type: "llm-graded"; value: unknown; rubric?: string },
          graderConfig,
        );
      }
      // "contains" — expected.value MUST be string[] of types that must all
      // appear in actual. Order-agnostic; count-tolerant (extras are fine,
      // missing types fail).
      const allowed = Array.isArray(expected.value)
        ? (expected.value as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      if (allowed.length === 0) {
        return {
          pass: false,
          score: 0,
          reason: "contains grading requires expected.value: string[]",
        };
      }
      // Compare on string identity — `actual[i].type` is the narrow
      // ExtractedItemType union but `allowed` is plain string[] (fixtures
      // are JSON, no compile-time narrowing possible). Widening both sides
      // to string sidesteps the union-mismatch without runtime cost.
      const seen = new Set<string>(actual.map((c) => c.type as string));
      const missing = allowed.filter((t) => !seen.has(t));
      const pass = missing.length === 0;
      return {
        pass,
        score: pass ? 1 : 0,
        reason: pass
          ? `all expected types present (${allowed.join(", ")})`
          : `missing types [${missing.join(", ")}] — got [${[...seen].join(", ") || "empty"}]`,
      };
    },
  };
}
