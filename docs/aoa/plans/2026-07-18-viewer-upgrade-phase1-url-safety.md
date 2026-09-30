# Viewer Upgrade — Phase 1: URL Scheme-Safety Security Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that a dangerous URL scheme (`javascript:`/`file:`/`data:`/`blob:`/`vbscript:`) or protocol-relative/backslash form can never reach an in-app iframe `src`, by adding one robust isomorphic `toSafeBrowserUrl` gate and applying it at **every iframe `src` sink**.

**Architecture (revised after Codex review):** Every in-app browser tab (Commander, Discussions/thread, Inbox Hub) renders through the shared `BrowserViewer` component; only the two Workspace preview iframes are separate. Rather than rewrite the four source normalizers (hub/thread already canonicalize via `new URL()`, and their tests depend on that), we **gate at the sinks**: wrap each iframe `src` (and `BrowserViewer.initialUrl`) with `toSafeBrowserUrl`. This closes every bypass — including the ones where `src` is seeded directly from `tab.url` / `output.url` / `previewUrl` without passing through a normalizer — and changes **zero** existing canonicalization behavior, so no existing test breaks.

**Tech Stack:** TypeScript (NodeNext `.js` in shared), Vitest (root `pnpm test:run <path>`; UI project uses jsdom), React.

**Design source:** [Build 1 (A/D/E) Design Spec §3.10](./2026-07-18-viewer-upgrade-build1-design.md).

**Scope / deferred (intentional):**
- **Agent-emitted URLs** + same-origin/relative rejection + confirmation → Phase 6. (Relative `/…` stays allowed here — the dev-server preview needs same-origin relative proxy paths.)
- **iframe `sandbox` / origin isolation** → deferred. Codex correctly notes that for the same-origin *proxied* dev-server preview, `allow-scripts allow-same-origin` is not a real isolation boundary (content can remove its own sandbox), and adding it risks breaking modals/downloads/OAuth popups. Proper isolation (separate origin) is a distinct design, tracked separately. Phase 1 delivers scheme-gating only.
- **Other unsandboxed iframes** — plugin launchers (`ui/src/plugins/launchers.tsx:423`) and the PDF fallback (`ui/src/components/viewers/PdfDocumentViewer.tsx:99`) are different URL/trust paths; explicitly out of scope.

---

## File Structure

- **Create** `packages/shared/src/safe-browser-url.ts` — the isomorphic gate.
- **Create** `packages/shared/src/safe-browser-url.test.ts` — exhaustive unit tests.
- **Modify** `packages/shared/src/index.ts` — barrel export.
- **Modify** `ui/src/components/viewers/BrowserViewer.tsx` — gate `initialUrl` at seed and gate the iframe `src` sink (this covers Commander/thread/hub browser tabs, which all render here).
- **Create** `ui/src/components/viewers/BrowserViewer.test.tsx` — jsdom render test proving a dangerous `initialUrl` never becomes the iframe `src`.
- **Modify** `ui/src/components/workspace/WorkspacePreviewPanel.tsx` — gate the two iframe `src` sinks (BrowserTabView ≈L427 and dev-server ≈L1062).

**Not touched:** the `normalizeUrl` functions in `hubViewerModel.ts`, `threadViewerModel.ts`, `WorkspacePreviewPanel.tsx`, and `normalizeBrowserUrl` in `BrowserViewer.tsx` keep their existing shaping/canonicalization. Safety is enforced at the sink.

---

## Task 1: Isomorphic `toSafeBrowserUrl` gate (shared)

**Files:**
- Create: `packages/shared/src/safe-browser-url.ts`
- Test: `packages/shared/src/safe-browser-url.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/safe-browser-url.test.ts
import { describe, it, expect } from "vitest";
import { toSafeBrowserUrl } from "./safe-browser-url.js";

const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);

describe("toSafeBrowserUrl", () => {
  it("passes http/https through unchanged", () => {
    expect(toSafeBrowserUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(toSafeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });
  it("passes about:blank, single-slash relative, schemeless host, and host:port", () => {
    expect(toSafeBrowserUrl("about:blank")).toBe("about:blank");
    expect(toSafeBrowserUrl("/preview/services/abc/")).toBe("/preview/services/abc/");
    expect(toSafeBrowserUrl("example.com")).toBe("example.com");
    expect(toSafeBrowserUrl("localhost:3000")).toBe("localhost:3000");
    expect(toSafeBrowserUrl("127.0.0.1:5173")).toBe("127.0.0.1:5173");
  });
  it("trims surrounding whitespace and returns empty for empty input", () => {
    expect(toSafeBrowserUrl("  https://x.com/  ")).toBe("https://x.com/");
    expect(toSafeBrowserUrl("")).toBe("");
    expect(toSafeBrowserUrl("   ")).toBe("");
  });
  it("blocks dangerous schemes to about:blank (with or without //)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "blob:https://x.com/uuid",
      "vbscript:msgbox(1)",
      "ftp://host/f",
    ]) {
      expect(toSafeBrowserUrl(bad)).toBe("about:blank");
    }
  });
  it("blocks protocol-relative and backslash network-path forms", () => {
    expect(toSafeBrowserUrl("//evil.com")).toBe("about:blank");
    expect(toSafeBrowserUrl("/" + "\" + "evil.com")).toBe("about:blank");
    expect(toSafeBrowserUrl("\" + "\" + "evil.com")).toBe("about:blank");
    expect(toSafeBrowserUrl("\" + "evil.com")).toBe("about:blank");
  });
  it("blocks embedded control characters", () => {
    expect(toSafeBrowserUrl("java" + TAB + "script:alert(1)")).toBe("about:blank");
    expect(toSafeBrowserUrl("https://x.com/" + NUL)).toBe("about:blank");
  });
  it("is case-insensitive on scheme", () => {
    expect(toSafeBrowserUrl("HTTPS://x.com")).toBe("HTTPS://x.com");
    expect(toSafeBrowserUrl("JavaScript:alert(1)")).toBe("about:blank");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run packages/shared/src/safe-browser-url.test.ts`
Expected: FAIL — `Cannot find module './safe-browser-url.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/safe-browser-url.ts
// Isomorphic scheme-safety GATE for a URL about to become an in-app iframe src.
// Returns the input unchanged when its scheme is safe (http/https, about:blank,
// single-slash app-relative, or a schemeless host[:port]); returns "about:blank"
// for dangerous schemes (javascript/data/file/blob/vbscript and any non-http(s)
// scheme://), protocol-relative "//"/backslash network-path forms, or control chars.
// This is a GATE, not a canonicalizer -- callers keep their own shaping. A URL is
// caller-supplied data; never trust its scheme.
const DANGEROUS_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob"]);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const SCHEME_SLASHSLASH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true; // C0 controls + DEL
  }
  return false;
}

export function toSafeBrowserUrl(value: string): string {
  const t = value.trim();
  if (!t) return "";
  if (t === "about:blank") return "about:blank";
  if (hasControlChar(t)) return "about:blank";
  // Backslash and protocol-relative forms resolve cross-origin in browsers.
  if (t.startsWith("\")) return "about:blank";
  if (t.startsWith("//")) return "about:blank";
  if (t.startsWith("/\")) return "about:blank";
  if (t.startsWith("/")) return t; // single-slash app / dev-server relative
  const m = SCHEME_RE.exec(t);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (SCHEME_SLASHSLASH_RE.test(t)) {
      // absolute scheme:// -- only http/https allowed
      return scheme === "http" || scheme === "https" ? t : "about:blank";
    }
    // "scheme:" with no // -- block dangerous schemes; otherwise treat as host[:port]
    if (DANGEROUS_SCHEMES.has(scheme)) return "about:blank";
    return t;
  }
  return t; // schemeless host
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run packages/shared/src/safe-browser-url.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/safe-browser-url.ts packages/shared/src/safe-browser-url.test.ts
git commit -m "feat(viewer): add isomorphic toSafeBrowserUrl scheme-safety gate"
```

---

## Task 2: Export from the shared barrel

**Files:** Modify `packages/shared/src/index.ts`

- [ ] **Step 1: Add the export** next to the other `export * from "./...js"` lines (e.g. after the Phase-0 `viewer-show-ref.js` export at ~L1298):

```ts
export * from "./safe-browser-url.js";
```

- [ ] **Step 2: Typecheck** — Run: `pnpm --filter @armyofagents/shared typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "chore(viewer): export toSafeBrowserUrl from @armyofagents/shared"
```

---

## Task 3: Gate `BrowserViewer` (covers Commander / thread / hub browser tabs)

**Files:**
- Modify `ui/src/components/viewers/BrowserViewer.tsx`
- Create `ui/src/components/viewers/BrowserViewer.test.tsx`

`BrowserViewer` is the single render surface for every browser tab across Commander, Discussions, and the Inbox Hub. Gating its `initialUrl` seed and its iframe `src` secures all of them at once. The existing `normalizeBrowserUrl` (URL-bar shaping) is left as-is; the `src` sink is the safety boundary.

- [ ] **Step 1: Write the failing render test**

```tsx
// ui/src/components/viewers/BrowserViewer.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { BrowserViewer } from "./BrowserViewer";

afterEach(cleanup);

describe("BrowserViewer scheme safety", () => {
  it("never renders a dangerous initialUrl as the iframe src", () => {
    const { queryByTestId } = render(<BrowserViewer initialUrl="javascript:alert(1)" />);
    const iframe = queryByTestId("thread-browser-iframe") as HTMLIFrameElement | null;
    // dangerous initialUrl is neutralized to about:blank, so the frame is not shown as a live src
    expect(iframe?.getAttribute("src") ?? "about:blank").not.toContain("javascript:");
  });
  it("renders a safe initialUrl as the iframe src", () => {
    const { getByTestId } = render(<BrowserViewer initialUrl="https://example.com" />);
    expect(getByTestId("thread-browser-iframe").getAttribute("src")).toBe("https://example.com");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run ui/src/components/viewers/BrowserViewer.test.tsx`
Expected: FAIL — dangerous `initialUrl` currently reaches the iframe `src`.
(If `@testing-library/react` is not already a dev dependency, STOP and report NEEDS_CONTEXT; check `ui/package.json` first — the repo's UI tests indicate a jsdom+RTL setup, but confirm before adding a dependency.)

- [ ] **Step 3: Gate `initialUrl` and the iframe `src`**

Add the import and gate both the seed and the sink in `BrowserViewer.tsx`:

```ts
import { toSafeBrowserUrl } from "@armyofagents/shared";
```

Seed (replace the `useState` lines ≈L31-33):

```ts
  const safeInitial = toSafeBrowserUrl(initialUrl);
  const [iframeKey, setIframeKey] = useState(0);
  const [draftUrl, setDraftUrl] = useState(safeInitial === "about:blank" ? "" : safeInitial);
  const [url, setUrl] = useState(safeInitial || "about:blank");
```

Sink (the iframe `src`, ≈L84) — gate at render so no code path can seed a dangerous `src`:

```tsx
        <iframe
          key={iframeKey}
          title={url}
          src={toSafeBrowserUrl(url) || "about:blank"}
          className="min-h-0 flex-1 border-0 bg-background"
          sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
          data-testid="thread-browser-iframe"
        />
```

(Leave `normalizeBrowserUrl` and the rest of the component unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run ui/src/components/viewers/BrowserViewer.test.tsx`
Expected: PASS (2 blocks).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/viewers/BrowserViewer.tsx ui/src/components/viewers/BrowserViewer.test.tsx
git commit -m "fix(viewer): scheme-gate BrowserViewer initialUrl + iframe src sink"
```

---

## Task 4: Gate the two Workspace iframe `src` sinks

**Files:** Modify `ui/src/components/workspace/WorkspacePreviewPanel.tsx`

These two iframes get their `src` from `currentUrl` (seeded from `tab.url` and `output.url`, not only submit-time `normalizeUrl`) and from `runningService.previewUrl` directly. Gate at the `src` attribute so every path is covered.

- [ ] **Step 1: Add the import** at the top of the file:

```ts
import { toSafeBrowserUrl } from "@armyofagents/shared";
```

- [ ] **Step 2: Gate the BrowserTabView iframe (≈L427-433)**

```tsx
        <iframe
          key={iframeKey}
          src={toSafeBrowserUrl(currentUrl) || "about:blank"}
          className="min-h-0 flex-1 border-0"
          title={tab.title}
          data-testid="preview-browser-iframe"
        />
```

- [ ] **Step 3: Gate the dev-server iframe (≈L1062-1064)**

Wrap its `src` identically: `src={toSafeBrowserUrl(runningService.previewUrl) || "about:blank"}` (preserve the existing `key`, `className`, `title`, and any other attributes exactly; only wrap the `src` value).

- [ ] **Step 4: Typecheck** — Run: `pnpm --filter @armyofagents/ui typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/WorkspacePreviewPanel.tsx
git commit -m "fix(viewer): scheme-gate workspace preview + dev-server iframe src"
```

---

## Task 5: Completion gate

**Files:** none (verification)

- [ ] **Step 1: Confirm every iframe `src` for user/agent-influenced URLs is gated**

Run: `git grep -n "toSafeBrowserUrl" -- ui/src`
Expected: matches in `BrowserViewer.tsx` (seed + src), `WorkspacePreviewPanel.tsx` (both iframes), and the test.

Run: `git grep -nE "<iframe" -- ui/src/components/viewers/BrowserViewer.tsx ui/src/components/workspace/WorkspacePreviewPanel.tsx`
Expected: every `src` on these iframes is wrapped in `toSafeBrowserUrl(...)` (visually confirm each match).

- [ ] **Step 2: Existing viewer-model tests still pass (no canonicalization regressed)**

Run: `pnpm test:run ui/src/components/threads/__tests__/threadViewerModel.test.ts ui/src/components/commander/viewer/commanderViewerModel.test.ts`
Expected: PASS — these were untouched, proving the sink-gating approach didn't disturb canonicalization (`https://example.com/` trailing slash, raw-url fallback).

- [ ] **Step 3: Full typecheck, full test suite, build**

Run: `pnpm -r typecheck` → PASS.
Run: `pnpm test:run` → PASS (whole suite; confirms no cross-package regression).
Run: `pnpm build` → PASS.

- [ ] **Step 4: Commit (only if an incidental fix was needed)**

```bash
git add packages/shared ui/src
git commit -m "test(viewer): phase-1 url scheme-safety gate green"
```

(Explicit paths only — never `git add -A`; the worktree may contain untracked plan docs.)

---

## Self-Review

**Spec coverage (design §3.10):**
- One isomorphic `toSafeBrowserUrl`, server-reusable → Task 1/2. ✅
- Applied at every iframe `src` sink: BrowserViewer (covers Commander/thread/hub) + both Workspace iframes → Tasks 3, 4. ✅
- `initialUrl` gated → Task 3. ✅
- Blocks `javascript:`/`file:`/`data:`/`blob:`/`vbscript:`, non-http(s) `scheme://`, protocol-relative `//`, backslash forms, control chars; allows http/https/about:blank/relative/schemeless-host — Task 1 tests. ✅

**How the Codex findings are resolved:**
- *Broken validator* → rewritten: `new URL`-class scheme handling, blocks `//evil`/`/\evil`/`\evil`, preserves `localhost:3000`, blocks controls. Tests cover each.
- *Workspace bypasses (L344/L680/L1064)* → gating moved to the iframe `src` sink, which every path flows through.
- *Broke existing canonicalization/tests* → the four source normalizers are **not touched**; Task 5 Step 2 explicitly re-runs the tests that encode canonicalization to prove it.
- *Sandbox theater + risk* → sandbox/origin-isolation deferred out of Phase 1 (documented in Scope).
- *Wrong commands / weak tests* → correct `__tests__` paths, a real jsdom render test, and full `pnpm test:run` + `pnpm build` in the gate.
- *`git add -A`* → replaced with explicit paths; only one task touches WorkspacePreviewPanel (no concurrent-edit hazard).

**Placeholder scan:** none — each change is a fully specified surgical edit; Task 4 Step 3 says "preserve existing attributes, wrap the `src`" because exact neighboring lines must be read, but the change itself is exact.

**Type consistency:** `toSafeBrowserUrl(value: string): string` identical at every call site.

---

## Execution Handoff

Plan complete. Execution: **subagent-driven**, one implementer per task with spec + code-quality review. No task requires a running app (sandbox/live-preview verification was removed from scope), so Phase 1 executes and verifies entirely from tests + typecheck + build.
