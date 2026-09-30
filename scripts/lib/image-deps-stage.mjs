/**
 * image-deps-stage.mjs — pure logic for the split-image deps-stage parity check
 * (DEP-001). No filesystem I/O: the CLI wrapper
 * `scripts/check-image-deps-stages.mjs` supplies the Dockerfile text and the
 * parsed workspace manifests; this module decides parity.
 *
 * ★ THE EQUIVALENCE IS NARROWER THAN IT LOOKS. This module's `computeRuntimeClosure` walks
 * `.dependencies` ONLY (see `indexPackages`), which is what makes it byte-equal to pnpm's
 * `--filter-prod "X..."` selection — the property the Dockerfiles rely on. But `--filter-prod`
 * ALSO traverses `optionalDependencies`, which `indexPackages` ignores entirely. Zero workspace
 * manifests declare one today, so the two agree; the FIRST one to do so would silently re-open
 * the gap this guard closes, with the guard still green. If you add an `optionalDependencies`
 * block to any workspace package, teach `indexPackages` about it in the same commit.
 *
 * Least-privilege invariant: each split image's `deps` stage must `COPY`
 * EXACTLY the set of workspace-package manifests in its own runtime dependency
 * closure — no fewer (or the install is incomplete) and NO MORE (or the image
 * drags in code it must not contain, e.g. the worker pulling server/db). This is
 * the machine-checkable form of "each image's deps stage copies exactly its
 * dependency closure and no more" (plan §2.2), and for the worker it enforces
 * the worker's own closure. That closure was E4-D01's fixed two packages until Blocker B
 * gave `worker-networked-host` (DEP-011 Slice 2b's container boot root) an image home; it is
 * now seven, and `IMAGES[].entryPackages` in the CLI wrapper is the single place that says so.
 *
 * Dependencies: `node:path` only, for pure path arithmetic (no reads).
 */

import path from "node:path";

/**
 * Extract the body lines of a named Dockerfile build stage
 * (`FROM ... AS <stage>` up to the next `FROM`). Returns null if not found.
 * @param {string} dockerfileText
 * @param {string} stageName
 * @returns {string|null}
 */
export function extractStage(dockerfileText, stageName) {
  const lines = String(dockerfileText).split(/\r?\n/);
  const fromRe = /^\s*FROM\s+/i;
  const asRe = new RegExp(`^\\s*FROM\\s+.+\\s+AS\\s+${escapeRegExp(stageName)}\\s*$`, "i");
  let inStage = false;
  const body = [];
  for (const line of lines) {
    if (asRe.test(line)) {
      inStage = true;
      continue;
    }
    if (inStage && fromRe.test(line)) break;
    if (inStage) body.push(line);
  }
  return inStage ? body.join("\n") : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Given the lines of a stage, return the set of workspace directories whose
 * `package.json` is COPYed (e.g. `COPY server/package.json server/` →
 * `server`; `COPY packages/db/package.json packages/db/` → `packages/db`).
 *
 * Only `<dir>/package.json` sources with a directory prefix count as workspace
 * manifests; the root `COPY package.json pnpm-workspace.yaml ...` (no slash) and
 * `COPY patches/ patches/` are infrastructure and ignored.
 *
 * @param {string} stageText
 * @returns {string[]} sorted, de-duplicated workspace dirs (posix separators)
 */
export function copiedWorkspaceDirs(stageText) {
  const dirs = new Set();
  const lines = String(stageText).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!/^COPY\b/i.test(line)) continue;
    // strip a leading `COPY` and any `--flag=...` options, then take tokens
    const rest = line.replace(/^COPY\b/i, "").trim();
    const tokens = rest.split(/\s+/).filter((t) => !t.startsWith("--"));
    // last token is the destination; the rest are sources
    const sources = tokens.slice(0, -1);
    for (const src of sources) {
      const normalized = src.replaceAll("\\", "/");
      if (!normalized.includes("/")) continue; // root package.json etc.
      if (!/\/package\.json$/.test(normalized)) continue;
      dirs.add(normalized.replace(/\/package\.json$/, ""));
    }
  }
  return [...dirs].sort();
}

/**
 * Compute the transitive runtime workspace closure of a set of entry packages.
 *
 * @param {string[]} entryNames package names (e.g. `@armyofagents/server`)
 * @param {Map<string,{dir:string, runtimeWorkspaceDeps:string[]}>} packagesByName
 * @returns {{names:Set<string>, dirs:Set<string>, missing:string[]}}
 *   `missing` = entry/dep names not present in the manifest map.
 */
export function computeRuntimeClosure(entryNames, packagesByName) {
  const names = new Set();
  const dirs = new Set();
  const missing = [];
  const stack = [...entryNames];
  while (stack.length > 0) {
    const name = stack.pop();
    if (names.has(name)) continue;
    const info = packagesByName.get(name);
    if (!info) {
      missing.push(name);
      continue;
    }
    names.add(name);
    dirs.add(info.dir.replaceAll("\\", "/"));
    for (const dep of info.runtimeWorkspaceDeps) {
      if (!names.has(dep)) stack.push(dep);
    }
  }
  return { names, dirs, missing };
}

/**
 * Evaluate a single split image's deps-stage parity.
 *
 * @param {{
 *   imageName: string,
 *   dockerfileText: string,
 *   entryPackages: string[],
 *   packagesByName: Map<string,{dir:string, runtimeWorkspaceDeps:string[]}>,
 *   stageName?: string,
 * }} args
 * @returns {string[]} policy-violation messages (empty ⇒ parity holds)
 */
export function evaluateImageDepsStage({
  imageName,
  dockerfileText,
  entryPackages,
  packagesByName,
  stageName = "deps",
}) {
  const errors = [];
  const stage = extractStage(dockerfileText, stageName);
  if (stage === null) {
    errors.push(`${imageName}: could not find a 'FROM ... AS ${stageName}' stage`);
    return errors;
  }

  const { dirs: expectedDirs, missing } = computeRuntimeClosure(entryPackages, packagesByName);
  for (const name of missing) {
    errors.push(`${imageName}: entry/dependency package not found in workspace: ${name}`);
  }

  const copied = new Set(copiedWorkspaceDirs(stage));
  const expected = new Set([...expectedDirs].map((d) => d.replaceAll("\\", "/")));

  for (const dir of [...expected].sort()) {
    if (!copied.has(dir)) {
      errors.push(`${imageName}: deps stage is MISSING closure manifest: COPY ${dir}/package.json ${dir}/`);
    }
  }
  for (const dir of [...copied].sort()) {
    if (!expected.has(dir)) {
      errors.push(
        `${imageName}: deps stage COPYs ${dir}/package.json which is OUTSIDE the image closure (least-privilege violation)`,
      );
    }
  }
  return errors;
}

/**
 * Build a `packagesByName` map from raw manifest records.
 * @param {Array<{dir:string, manifest:object}>} records
 * @returns {Map<string,{dir:string, runtimeWorkspaceDeps:string[]}>}
 */
export function indexPackages(records) {
  const known = new Set(records.map((r) => r.manifest?.name).filter(Boolean));
  const map = new Map();
  for (const { dir, manifest } of records) {
    if (!manifest || typeof manifest.name !== "string") continue;
    const deps = manifest.dependencies ?? {};
    const devDeps = manifest.devDependencies ?? {};
    const runtimeWorkspaceDeps = Object.keys(deps).filter((k) => known.has(k));
    // E6-F012: recorded but NOT mixed into `runtimeWorkspaceDeps`. The runtime walk
    // must stay `.dependencies`-only (it mirrors `--filter-prod`); the dev edges are
    // a second, separately-reported set consumed by `computeBuildClosure`.
    const devWorkspaceDeps = Object.keys(devDeps).filter((k) => known.has(k));
    map.set(manifest.name, {
      dir: path.posix.normalize(dir.replaceAll("\\", "/")),
      runtimeWorkspaceDeps,
      devWorkspaceDeps,
    });
  }
  return map;
}

// ===========================================================================
// E6-F012 — THE BUILD SELECTION IS A DIFFERENT SET FROM THE INSTALLED SET.
//
// Everything above answers "what does the deps stage INSTALL?", and it answers it
// against `.dependencies` alone so that it is byte-equal to `--filter-prod "X..."`.
// The build stage asks a different question. `pnpm --filter "X..." build` traverses
// `devDependencies` TOO, so the set it compiles is the DEV closure — which at
// DEP-011 Slice 1 (`c3d26657d`) grew past the prod closure for the first time and
// killed the control-plane image build, while this guard stayed green and correct.
//
// ★ THE ASSERTABLE INVARIANT IS NOT "the deps stage must COPY the dev closure".
// That would destroy the least-privilege property the whole file exists to enforce:
// the deps stage's install is what reaches `pnpm deploy --prod`, and widening it
// puts the fake provider and the worker daemon into the control-plane image. The
// invariant is CONDITIONAL and it lives one stage later:
//
//     IF the build closure is strictly larger than the runtime closure,
//     THEN the build stage MUST absorb the difference —
//       (a) by re-installing (`RUN pnpm install`, NOT `--prod`/`--filter-prod`,
//           or the install re-selects the prod set and absorbs nothing), and
//       (b) with the divergent packages' manifests actually PRESENT in that
//           stage, or the re-install has nothing to resolve.
//
// (a) is the mechanism WRK-017 used for the control-plane, and the one the worker
// image had already used for its "8th manifest". (b) is what makes the rule BITE:
// the worker build stage deliberately does NOT `COPY . .` (a whole-tree copy would
// make every `dockerfile-static` exclusion grep vacuous), so for THAT image a new
// workspace devDependency is still a real break — and (a) alone would not see it.
//
// Both clauses are decided from text this module already parses. Nothing here
// executes docker, and nothing here substitutes for actually building the images;
// see E6-F013 / DEP-013 for the lane that does.
// ===========================================================================

/**
 * Transitive workspace closure over `dependencies` ∪ `devDependencies` — the set
 * `pnpm --filter "<entry>..." build` selects. Deliberately a SEPARATE function
 * from `computeRuntimeClosure`: that one's `.dependencies`-only walk is a
 * load-bearing mirror of `--filter-prod` and must not grow a mode flag.
 *
 * @param {string[]} entryNames
 * @param {Map<string,{dir:string, runtimeWorkspaceDeps:string[], devWorkspaceDeps?:string[]}>} packagesByName
 * @returns {{names:Set<string>, dirs:Set<string>, missing:string[]}}
 */
export function computeBuildClosure(entryNames, packagesByName) {
  const names = new Set();
  const dirs = new Set();
  const missing = [];
  const stack = [...entryNames];
  while (stack.length > 0) {
    const name = stack.pop();
    if (names.has(name)) continue;
    const info = packagesByName.get(name);
    if (!info) {
      missing.push(name);
      continue;
    }
    names.add(name);
    dirs.add(info.dir.replaceAll("\\", "/"));
    for (const dep of [...info.runtimeWorkspaceDeps, ...(info.devWorkspaceDeps ?? [])]) {
      if (!names.has(dep)) stack.push(dep);
    }
  }
  return { names, dirs, missing };
}

/**
 * Join Dockerfile backslash continuations into logical lines, so a multi-line
 * `RUN pnpm install --frozen-lockfile \` + `  --filter-prod "x..."` is read as the
 * ONE command it is. Reading it as two would let a `--filter-prod` sitting on a
 * continuation line hide from the absorption check below.
 * @param {string} stageText
 * @returns {string[]}
 */
export function logicalLines(stageText) {
  const out = [];
  let acc = null;
  for (const raw of String(stageText).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const continues = /\\$/.test(line);
    const body = continues ? line.slice(0, -1) : line;
    acc = acc === null ? body : acc + " " + body.trim();
    if (!continues) {
      out.push(acc.trim());
      acc = null;
    }
  }
  if (acc !== null) out.push(acc.trim());
  return out;
}

/** The base image or parent stage of `FROM <base> AS <stageName>`; null if absent. */
export function stageParent(dockerfileText, stageName) {
  const re = new RegExp("^\\s*FROM\\s+(\\S+)\\s+AS\\s+" + escapeRegExp(stageName) + "\\s*$", "i");
  for (const line of String(dockerfileText).split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * The BUILD-CONTEXT source paths a stage COPYs (normalized, no trailing slash).
 *
 * `COPY --from=<stage> ...` lines are deliberately EXCLUDED: they move an already
 * built or installed tree between stages, not source manifests out of the build
 * context. `FROM <stage>` inheritance is followed separately by
 * `stageContextSources`, which is how the worker's `FROM deps AS build` gets credit
 * for the deps stage's COPYs. If a manifest ever starts arriving by an explicit
 * `--from=` copy, this function must learn about it — today none does.
 *
 * @param {string} stageText
 * @returns {string[]}
 */
export function copiedContextSources(stageText) {
  const sources = [];
  for (const line of logicalLines(stageText)) {
    if (!/^COPY\b/i.test(line)) continue;
    const rest = line.replace(/^COPY\b/i, "").trim();
    if (/(^|\s)--from=/i.test(rest)) continue;
    const tokens = rest.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("--"));
    if (tokens.length < 2) continue;
    for (const src of tokens.slice(0, -1)) {
      sources.push(src.replaceAll("\\", "/").replace(/\/+$/, "") || ".");
    }
  }
  return sources;
}

/**
 * Every build-context source visible to `stageName`, following `FROM <stage>`
 * inheritance inside the same Dockerfile (cycle-safe).
 * @param {string} dockerfileText
 * @param {string} stageName
 * @returns {string[]}
 */
export function stageContextSources(dockerfileText, stageName) {
  const sources = [];
  const seen = new Set();
  let cursor = stageName;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const body = extractStage(dockerfileText, cursor);
    if (body === null) break;
    sources.push(...copiedContextSources(body));
    cursor = stageParent(dockerfileText, cursor);
  }
  return sources;
}

/** Does any COPY source cover the workspace directory `dir` (whole-tree, prefix, or its manifest)? */
export function sourcesCoverDir(sources, dir) {
  const target = String(dir).replaceAll("\\", "/").replace(/\/+$/, "");
  for (const raw of sources) {
    const s = String(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    if (s === "" || s === ".") return true; // COPY . .  — the whole tree
    if (s === target) return true;
    if (s === target + "/package.json") return true;
    if (target.startsWith(s + "/")) return true;
  }
  return false;
}

/**
 * The absorption verdict for ONE image. Empty ⇒ either there is no divergence to
 * absorb, or the build stage absorbs it.
 *
 * @param {{
 *   imageName: string,
 *   dockerfileText: string,
 *   entryPackages: string[],
 *   packagesByName: Map<string,{dir:string, runtimeWorkspaceDeps:string[], devWorkspaceDeps?:string[]}>,
 *   buildStageName?: string,
 * }} args
 * @returns {string[]}
 */
export function evaluateBuildStageAbsorption({
  imageName,
  dockerfileText,
  entryPackages,
  packagesByName,
  buildStageName = "build",
}) {
  const errors = [];
  const prod = computeRuntimeClosure(entryPackages, packagesByName);
  const build = computeBuildClosure(entryPackages, packagesByName);
  const divergent = [...build.names].filter((n) => !prod.names.has(n)).sort();
  // No divergence => the deps stage's install IS the build selection, and the build
  // stage needs no re-install. Asserting one unconditionally would make this guard
  // demand the very widening the least-privilege rule above forbids.
  if (divergent.length === 0) return errors;

  const listed = divergent.join(", ");
  const stage = extractStage(dockerfileText, buildStageName);
  if (stage === null) {
    errors.push(
      `${imageName}: the build closure exceeds the runtime closure by ${divergent.length} package(s) (${listed}) but there is no 'FROM ... AS ${buildStageName}' stage to absorb it — 'pnpm --filter "X..." build' would compile packages that nothing installed (E6-F012)`,
    );
    return errors;
  }

  const installs = logicalLines(stage).filter(
    (l) => /^RUN\b/i.test(l) && /\bpnpm\b.*\binstall\b/i.test(l),
  );
  const absorbing = installs.filter((l) => !/--(filter-)?prod\b/i.test(l));
  if (installs.length === 0) {
    errors.push(
      `${imageName}: the build closure exceeds the runtime closure by ${divergent.length} package(s) (${listed}) but the '${buildStageName}' stage has NO re-install — add 'RUN pnpm install --frozen-lockfile --filter "<entry>..."' there so the installed set is the set being built (E6-F012)`,
    );
  } else if (absorbing.length === 0) {
    errors.push(
      `${imageName}: the '${buildStageName}' stage re-installs, but every pnpm install there is --prod/--filter-prod, which re-selects the RUNTIME closure and absorbs nothing — the ${divergent.length} build-only package(s) (${listed}) stay uninstalled (E6-F012)`,
    );
  }

  // A re-install can only resolve a package whose manifest is present in the stage.
  const sources = stageContextSources(dockerfileText, buildStageName);
  for (const name of divergent) {
    const info = packagesByName.get(name);
    if (!info) continue; // already reported as `missing` by the deps-stage pass
    const dir = info.dir.replaceAll("\\", "/");
    if (!sourcesCoverDir(sources, dir)) {
      errors.push(
        `${imageName}: build-only closure package ${name} has no manifest in the '${buildStageName}' stage — add 'COPY ${dir}/package.json ${dir}/' THERE (never to deps: that stage's COPY set is the least-privilege runtime closure) (E6-F012)`,
      );
    }
  }
  return errors;
}

// ===========================================================================
// E6-F012 clause (a2) — WHAT IS BUILT MUST BE WHAT WAS INSTALLED.
//
// ★ CLAUSE (a) ABOVE TESTS THE FLAG, NOT THE SELECTION, and that is only half the
// question. It asks "is there a `pnpm install` in this stage without
// `--prod`/`--filter-prod`?" — so it is satisfied by an install that absorbs
// nothing at all. MEASURED on the real tree at `da1a90597`: replacing the
// control-plane build stage's
//     RUN pnpm install --frozen-lockfile --filter "@armyofagents/server..." --filter "@armyofagents/ui..."
// with
//     RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-protocol..."
// while leaving the `pnpm --filter "@armyofagents/server..." --filter "@armyofagents/ui..." build`
// line untouched left the whole gate GREEN. That is `c3d26657d`'s failure mode
// exactly — the BUILD selection strictly exceeding the INSTALLED selection — and
// clause (a) cannot see it, because both lines are non-prod.
//
// So the selections themselves are compared here. For each `pnpm ... build` line
// in the stage, the package set its `--filter`/`--filter-prod` selects must be a
// subset of the set the stage's installs (its own, plus any inherited through
// `FROM <stage>`) selected. Both sides are intersected with the manifests
// actually PRESENT in the stage, because pnpm's `...` walks the DISCOVERED
// workspace — a filter cannot select a package whose directory never arrived, so
// an uncopied package is not an install gap here (clause (b) owns that case).
//
// This is UNCONDITIONAL — it does not require a dev/prod divergence. "Build only
// what you installed" is true of a stage with no divergence at all, and the probe
// above is exactly such a case.
//
// What it still does NOT cover, stated rather than implied: pnpm filter syntax
// beyond a plain package name with an optional `...` suffix (`^...`, `...^`,
// globs, path and changed-since selectors) — those are REPORTED as unparseable
// rather than silently read as "selects nothing", which would make the subset test
// vacuous; ORDERING (an install placed after the build line reads the same as one
// before it); and anything that requires actually building an image.
// ===========================================================================

/** Is this logical line a `RUN ... pnpm ... install ...`? */
function isPnpmInstallLine(line) {
  return /^RUN\b/i.test(line) && /\bpnpm\b/i.test(line) && /\binstall\b/i.test(line);
}

/**
 * Is this logical line a `RUN ... pnpm ... build` (the workspace build script)?
 *
 * `build` must appear as a WHOLE token, which is what separates `pnpm --filter "X..." build`
 * and `pnpm --filter "X..." run build` from `pnpm --filter X deploy --prod /cp-app` — the
 * deploy line simply carries no such token, so it needs no special case. An earlier draft
 * of this predicate excluded any line containing `deploy`; that clause could not change a
 * verdict on any realistic line and would have SUPPRESSED a real build on a compound
 * `RUN pnpm deploy … && pnpm build`, so it is deliberately absent.
 */
function isPnpmBuildLine(line) {
  if (!/^RUN\b/i.test(line) || !/\bpnpm\b/i.test(line)) return false;
  if (/\binstall\b/i.test(line)) return false;
  return /(^|\s)build(\s|$)/i.test(line.replace(/^RUN\b/i, ""));
}

/**
 * The `--filter` / `--filter-prod` selectors on one logical command line. Accepts
 * `--filter X`, `--filter=X`, and quoted values. Selectors this parser does not
 * understand are returned separately in `unparsed` so the caller can report them.
 *
 * @param {string} line
 * @returns {{selectors:Array<{prod:boolean, name:string, transitive:boolean}>, unparsed:string[]}}
 */
export function parseFilterSelectors(line) {
  const selectors = [];
  const unparsed = [];
  const tokens = String(line).split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const m = /^--filter(-prod)?(?:=(.*))?$/i.exec(tokens[i]);
    if (!m) continue;
    const prod = Boolean(m[1]);
    let raw = m[2] !== undefined ? m[2] : tokens[i + 1];
    if (m[2] === undefined) i += 1;
    if (raw === undefined || raw === "") {
      unparsed.push(tokens[i - 1] ?? "--filter");
      continue;
    }
    raw = raw.replace(/^["']/, "").replace(/["']$/, "");
    const sm = /^(@?[A-Za-z0-9._\-/]+?)(\.\.\.)?$/.exec(raw);
    if (!sm || raw.includes("*") || raw.includes("{") || raw.startsWith(".")) {
      unparsed.push(raw);
      continue;
    }
    selectors.push({ prod, name: sm[1], transitive: Boolean(sm[2]) });
  }
  return { selectors, unparsed };
}

/**
 * The workspace package names a set of selectors resolves to. NO selectors at all
 * ⇒ the whole workspace (a bare `pnpm install` installs everything discoverable).
 *
 * @param {Array<{prod:boolean,name:string,transitive:boolean}>} selectors
 * @param {Map<string,object>} packagesByName
 * @returns {Set<string>}
 */
export function resolveSelectorSet(selectors, packagesByName) {
  if (selectors.length === 0) return new Set(packagesByName.keys());
  const out = new Set();
  for (const sel of selectors) {
    if (!sel.transitive) {
      out.add(sel.name);
      continue;
    }
    const closure = sel.prod
      ? computeRuntimeClosure([sel.name], packagesByName)
      : computeBuildClosure([sel.name], packagesByName);
    for (const n of closure.names) out.add(n);
  }
  return out;
}

/** The last `WORKDIR` in effect for `stageName`, following `FROM <stage>` inheritance. */
export function stageWorkdir(dockerfileText, stageName) {
  const chain = [];
  const seen = new Set();
  let cursor = stageName;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const body = extractStage(dockerfileText, cursor);
    if (body === null) break;
    chain.unshift(body);
    cursor = stageParent(dockerfileText, cursor);
  }
  let wd = null;
  for (const body of chain) {
    for (const line of logicalLines(body)) {
      const m = /^WORKDIR\s+(\S+)\s*$/i.exec(line);
      if (m) wd = m[1].replaceAll("\\", "/").replace(/\/+$/, "");
    }
  }
  return wd;
}

/**
 * Every `pnpm install` a stage's node_modules actually reflects, WITH the stage each
 * one ran in (its selection is bounded by the manifests THAT stage could discover).
 *
 * Two inheritance routes, and both are load-bearing:
 *   * `FROM <stage> AS build` — the worker image's shape. The parent's install is
 *     literally still in the layer.
 *   * `COPY --from=<stage> <workdir> …` — the control-plane and adapter-manager
 *     shape. The installed tree is copied in wholesale, so the packages it installed
 *     ARE resolvable in this stage, and reporting them as uninstalled is a FALSE
 *     POSITIVE. Only a copy of that stage's own WORKDIR (or its `node_modules`)
 *     counts: a `COPY --from=deps /app/patches ./patches` moves no install, and
 *     crediting it would let a narrowed re-install hide behind an unrelated copy.
 *
 * @returns {Array<{line:string, stage:string}>}
 */
function visibleInstallLines(dockerfileText, stageName) {
  const out = [];
  const seen = new Set();
  const queue = [stageName];
  while (queue.length > 0) {
    const cursor = queue.shift();
    if (!cursor || seen.has(cursor)) continue;
    seen.add(cursor);
    const body = extractStage(dockerfileText, cursor);
    if (body === null) continue;
    for (const line of logicalLines(body)) {
      if (isPnpmInstallLine(line)) out.push({ line, stage: cursor });
    }
    const parent = stageParent(dockerfileText, cursor);
    if (parent) queue.push(parent);
    for (const from of copiedInstallTreeStages(dockerfileText, body)) queue.push(from);
  }
  return out;
}

/** Stages whose INSTALLED TREE this stage body copies in (see `visibleInstallLines`). */
function copiedInstallTreeStages(dockerfileText, stageText) {
  const stages = [];
  for (const line of logicalLines(stageText)) {
    if (!/^COPY\b/i.test(line)) continue;
    const m = /(^|\s)--from=(\S+)/i.exec(line);
    if (!m) continue;
    const from = m[2].replace(/^["']|["']$/g, "");
    const wd = stageWorkdir(dockerfileText, from);
    if (!wd) continue;
    const tokens = line
      .replace(/^COPY\b/i, "")
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0 && !t.startsWith("--"));
    for (const src of tokens.slice(0, -1)) {
      const s = src.replaceAll("\\", "/").replace(/\/+$/, "");
      if (s === wd || s === wd + "/node_modules") {
        stages.push(from);
        break;
      }
    }
  }
  return stages;
}

/**
 * Clause (a2): every package a `pnpm ... build` line in `buildStageName` selects
 * must also have been selected by an install visible to that stage.
 *
 * @param {{
 *   imageName: string,
 *   dockerfileText: string,
 *   packagesByName: Map<string,{dir:string, runtimeWorkspaceDeps:string[], devWorkspaceDeps?:string[]}>,
 *   buildStageName?: string,
 * }} args
 * @returns {string[]}
 */
export function evaluateBuildSelectionCoverage({
  imageName,
  dockerfileText,
  packagesByName,
  buildStageName = "build",
}) {
  const errors = [];
  const stage = extractStage(dockerfileText, buildStageName);
  if (stage === null) return errors; // no build stage ⇒ nothing is built here

  const buildLines = logicalLines(stage).filter(isPnpmBuildLine);
  if (buildLines.length === 0) return errors;

  const installLines = visibleInstallLines(dockerfileText, buildStageName);
  if (installLines.length === 0) return errors; // clause (a) owns "there is no re-install"

  const installed = new Set();
  for (const { line, stage: installStage } of installLines) {
    const { selectors, unparsed } = parseFilterSelectors(line);
    for (const u of unparsed) {
      errors.push(
        `${imageName}: unparseable pnpm filter selector ${JSON.stringify(u)} on an install visible to the '${buildStageName}' stage — teach parseFilterSelectors about it rather than leaving the build/install subset test vacuous (E6-F012)`,
      );
    }
    // Bounded by what THAT stage could discover. `--filter "@armyofagents/server..."`
    // in a `deps` stage holding only the 19 runtime manifests installs 19 packages,
    // not the 25 the same flag would select against the whole tree — pnpm's `...`
    // walks the DISCOVERED workspace. Crediting the unbounded set here would let the
    // deps stage's own filter vouch for packages it never installed.
    const discoverable = stageContextSources(dockerfileText, installStage);
    for (const n of resolveSelectorSet(selectors, packagesByName)) {
      const info = packagesByName.get(n);
      if (info && !sourcesCoverDir(discoverable, info.dir.replaceAll("\\", "/"))) continue;
      installed.add(n);
    }
  }

  const present = stageContextSources(dockerfileText, buildStageName);
  for (const line of buildLines) {
    const { selectors, unparsed } = parseFilterSelectors(line);
    for (const u of unparsed) {
      errors.push(
        `${imageName}: unparseable pnpm filter selector ${JSON.stringify(u)} on a build line in the '${buildStageName}' stage — teach parseFilterSelectors about it rather than leaving the build/install subset test vacuous (E6-F012)`,
      );
    }
    const uncovered = [...resolveSelectorSet(selectors, packagesByName)]
      .filter((n) => !installed.has(n))
      // pnpm's `...` walks the DISCOVERED workspace: a package whose directory never
      // entered this stage cannot be selected by the build line either. Clause (b)
      // owns that case, and double-reporting it here would only be noise.
      .filter((n) => {
        const info = packagesByName.get(n);
        return info ? sourcesCoverDir(present, info.dir.replaceAll("\\", "/")) : false;
      })
      .sort();
    if (uncovered.length > 0) {
      errors.push(
        `${imageName}: the '${buildStageName}' stage BUILDS ${uncovered.length} package(s) that no install there selected (${uncovered.join(", ")}) — widen the re-install's --filter to cover what the build line selects; being non-prod is not enough if the install selects a narrower set (E6-F012)`,
      );
    }
  }
  return errors;
}
