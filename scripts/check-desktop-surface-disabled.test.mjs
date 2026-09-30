#!/usr/bin/env node
/**
 * Adversarial corpus for the DSK-00 desktop-surface gate (I22 clauses 6 and 7). Run:
 *   node --test scripts/check-desktop-surface-disabled.test.mjs
 *
 * A checker nobody has tried to defeat is not a guard. This proves the gate REJECTS each
 * way a desktop distribution surface could reappear, ACCEPTS the shapes that must stay
 * legal, and — the part that matters most for this particular checker — does not fire on
 * the enormous amount of unrelated "desktop" prose in this repo.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  checkDocPin,
  checkNoDesktopRoutes,
  runDesktopSurfaceCheck,
  REQUIRED_DOC_PHRASES,
} from "./check-desktop-surface-disabled.mjs";

const DOC_OK = `
| H.D1 | Distribution format | **Docker + NPM only.** No desktop installer in Phase H. |
`;

test("clause 6 ACCEPTS the current decision row", () => {
  assert.deepEqual(checkDocPin(DOC_OK), []);
});

test("clause 6 REJECTS the promise being quietly dropped", () => {
  assert.equal(checkDocPin("| H.D1 | Distribution format | Docker + NPM only. |").length, 1);
  assert.equal(checkDocPin("| H.D1 | Distribution format | No desktop installer. |").length, 1);
  assert.equal(checkDocPin("nothing relevant here").length, REQUIRED_DOC_PHRASES.length);
});

test("clause 6 SURVIVES ordinary editing — it pins meaning, not bytes", () => {
  // A guard that fails on a reflow gets weakened until it fails on nothing.
  assert.deepEqual(
    checkDocPin("Distribution is **Docker + NPM only** for now;\nthere is no desktop installer yet."),
    [],
  );
});

const route = (path, source) => [{ path, source }];

test("clause 7 REJECTS a desktop distribution route, in either word order", () => {
  for (const line of [
    'router.get("/desktop/download", handler);',
    'router.get("/desktop-update", handler);',
    'router.post("/desktop_manifest", handler);',
    'router.get("/api/updates/desktop", handler);',
    'router.get("/download/desktop", handler);',
    'api.use("/desktop/release", desktopReleaseRoutes());',
    'router.get("/desktop/releases", handler);',
    'router.get("/api/packages/desktop", handler);',
  ]) {
    assert.equal(checkNoDesktopRoutes(route("server/src/routes/x.ts", line)).length, 1, line);
  }
});

test("clause 7 does NOT fire on an unrelated desktop mention", () => {
  // The failure mode this checker exists to avoid. `docs/` and `ui/` are full of
  // responsive-breakpoint "desktop", and a route file may legitimately mention the word.
  for (const source of [
    'router.get("/layout", () => ({ breakpoint: "desktop" }));',
    'const label = "desktop tier";',
    'router.get("/agents", handler); // desktop clients poll this too',
  ]) {
    assert.deepEqual(checkNoDesktopRoutes(route("server/src/routes/x.ts", source)), [], source);
  }
});

test("clause 7 does NOT fire on a COMMENT explaining that no such route exists", () => {
  // Third time this shape has come up in DSK-001: a checker that forces you to delete
  // the rationale for the thing it checks is a bad checker.
  const source = [
    "// DSK-00: there is deliberately no /desktop/download route here.",
    "/* nor a desktop-manifest endpoint — see DSK-001 Lane C. */",
    'router.get("/agents", handler);',
  ].join("\n");
  assert.deepEqual(checkNoDesktopRoutes(route("server/src/routes/x.ts", source)), []);
});

test("clause 7 does NOT fire on a TRAILING comment beside a real registration", () => {
  // Mutation found this gap. Removing comment-stripping altogether left the corpus
  // green, because the whole-line comments above are skipped by the route-registration
  // filter anyway — so the corpus could not tell the two mechanisms apart. Only a line
  // that IS a registration AND mentions the pattern in a trailing comment can, and that
  // is exactly the shape a reviewer writes when documenting why a route is absent.
  const source = 'router.get("/agents", handler); // deliberately not /desktop/download';
  assert.deepEqual(checkNoDesktopRoutes(route("server/src/routes/x.ts", source)), []);
});

test("clause 7 only inspects ROUTE REGISTRATIONS, not any line that mentions a path", () => {
  const source = 'const DESKTOP_DOWNLOAD_PATH = "/desktop/download"; // not registered';
  assert.deepEqual(checkNoDesktopRoutes(route("server/src/routes/x.ts", source)), []);
});

test("the gate FAILS when it has nothing to scan, rather than passing vacuously", () => {
  // A sweep that found no files must not report a clean bill of health. This is the
  // difference between "we checked and it is absent" and "we did not check".
  const { problems } = runDesktopSurfaceCheck("/definitely-not-a-repo-root");
  assert.ok(problems.some((p) => p.includes("vacuously")), JSON.stringify(problems));
});

test("the REAL repository passes clean", () => {
  const { problems, scanned } = runDesktopSurfaceCheck();
  assert.deepEqual(problems, []);
  assert.ok(scanned > 10, `only ${scanned} route files scanned`);
});
