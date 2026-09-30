import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

// ── Guard tests proving extraction never touches a hosted provider key ────────
//
// 1. STATIC guard: the extraction modules never reference provider-key helpers
//    or the deleted callLLM/callAnthropic/callOpenAI plumbing; the 4 crew tool
//    wrappers never reference ctx.services.extraction?.llm.
// 2. RUNTIME guard: a CLI-only extraction path makes ZERO calls to
//    getProviderApiKey / resolveAvailableProvider.
// 3. Crew error mapping: a CliExtractionError (not_installed/not_authed) maps to
//    EXTRACTION_LLM_UNAVAILABLE (the old /No LLM provider configured/i regex is
//    dead after the conversion).

const here = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(resolvePath(here, rel), "utf8");
}

describe("extraction modules never reference provider keys / callLLM (static guard)", () => {
  it("extraction.ts + extraction-engine.ts have no provider-key/hosted-LLM symbols", () => {
    for (const f of ["extraction.ts", "extraction-engine.ts"]) {
      const src = readSrc(`../services/${f}`);
      expect(src).not.toMatch(
        /callLLM|callAnthropic|callOpenAI|createProvider|resolveAvailableProvider/,
      );
    }
  });

  it("the 4 crew memory-extract tools never read ctx.services.extraction?.llm", () => {
    for (const t of ["candidates", "decisions", "insights", "references"]) {
      const src = readSrc(`../services/internal-agent/tools/memory-extract-${t}.ts`);
      expect(src).not.toMatch(/ctx\.services\.extraction\?\.llm/);
    }
  });
});

// ── RUNTIME guard ─────────────────────────────────────────────────────────────
// Re-import the real provider module and spy on its exports, then drive a CLI
// extraction. The spies must record ZERO calls.

describe("no extraction path calls getProviderApiKey/resolveAvailableProvider at runtime", () => {
  it("extractFromRawText + extractMemoryCandidates (no llm) never consult a key", async () => {
    vi.resetModules();

    const extractViaCli = vi.fn().mockResolvedValue([{ type: "insight", title: "I" }]);
    class FakeCliExtractionError extends Error {
      readonly kind: string;
      constructor(message: string, kind: string) {
        super(message);
        this.kind = kind;
      }
    }
    vi.doMock("../services/extraction-cli.js", () => ({
      extractViaCli,
      CliExtractionError: FakeCliExtractionError,
    }));

    const providers = await import("../services/internal-agent/providers/index.js");
    const spyKey = vi.spyOn(providers, "getProviderApiKey");
    const spyResolve = vi.spyOn(providers, "resolveAvailableProvider");

    const { extractionService, extractMemoryCandidates } = await import(
      "../services/extraction.js"
    );

    // Build a sequence DB that drives both paths without a real binary.
    function seqDb(selects: any[][]) {
      let idx = 0;
      function chain(): any {
        const c: any = {};
        for (const m of ["from", "where", "orderBy", "limit"]) c[m] = () => c;
        c.then = (resolve: (v: any[]) => any) => Promise.resolve(resolve(selects[idx++] ?? []));
        return c;
      }
      return { select: () => chain() } as any;
    }

    // extractFromRawText: departments(1), agent-config model(2)
    await extractionService(seqDb([[], [{ model: null }]])).extractFromRawText(
      "co-1",
      "raw text long enough to extract from",
    );

    // extractMemoryCandidates (no llm): privacy gate(1), entries(2), departments(3), model(4)
    await extractMemoryCandidates(
      seqDb([
        [{ allowMemoryExtraction: true }],
        [{ id: "e1", rawContent: "Substantive content.", createdAt: new Date() }],
        [],
        [{ model: null }],
      ]),
      null,
      { companyId: "co-1", threadId: "th-1" },
    );

    expect(extractViaCli).toHaveBeenCalled();
    expect(spyKey).not.toHaveBeenCalled();
    expect(spyResolve).not.toHaveBeenCalled();

    vi.doUnmock("../services/extraction-cli.js");
    vi.resetModules();
  });
});

// ── Crew tool error mapping ──────────────────────────────────────────────────

describe("crew tool maps CliExtractionError → EXTRACTION_LLM_UNAVAILABLE", () => {
  it("a not_installed CliExtractionError yields the CLI-unavailable error code", async () => {
    vi.resetModules();

    class FakeCliExtractionError extends Error {
      readonly kind: string;
      constructor(message: string, kind: string) {
        super(message);
        this.name = "CliExtractionError";
        this.kind = kind;
      }
    }

    // Mock the extraction service so the tool's call rejects with a CLI error.
    vi.doMock("../services/extraction.js", () => ({
      extractMemoryCandidates: vi
        .fn()
        .mockRejectedValue(new FakeCliExtractionError("claude CLI not found", "not_installed")),
    }));
    vi.doMock("../services/extraction-cli.js", () => ({
      CliExtractionError: FakeCliExtractionError,
    }));

    const { extractMemoryCandidatesTool } = await import(
      "../services/internal-agent/tools/memory-extract-candidates.js"
    );

    const res = await extractMemoryCandidatesTool.execute(
      { threadId: "th-1" },
      { db: {} as any, companyId: "co-1", services: {} } as any,
    );

    expect(res.success).toBe(false);
    expect(res.error).toBe("EXTRACTION_LLM_UNAVAILABLE");

    vi.doUnmock("../services/extraction.js");
    vi.doUnmock("../services/extraction-cli.js");
    vi.resetModules();
  });
});
