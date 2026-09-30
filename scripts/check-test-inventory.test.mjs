/**
 * Walk-level tests for the test-inventory guard.
 *
 * The pure verdict is tested in `lib/__tests__/test-inventory.test.mjs`. What is
 * tested HERE is the one thing only the filesystem layer can get wrong, and it is the
 * exact defect that caused the incident this guard exists for: FOLLOWING A SYMLINK
 * OUT OF THE ROOT. A checker that followed links would count files outside the
 * repository and could mask the deletion it is meant to detect.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { countTestFiles } from "./check-test-inventory.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aoa-inv-"));
  const write = (rel) => {
    const absolute = path.join(root, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "// fixture\n", "utf8");
  };
  return { root, write };
}

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

describe("countTestFiles — attribution", () => {
  it("counts per tree, splitting packages/* one level deeper", () => {
    const { root, write } = fixture();
    try {
      write("server/src/a.test.ts");
      write("server/src/b.test.ts");
      write("packages/worker-daemon/src/c.test.ts");
      write("packages/worker-keystore/src/__tests__/helper.ts");
      write("server/src/plain.ts");
      assert.deepEqual({ ...countTestFiles(root) }, {
        server: 2,
        "packages/worker-daemon": 1,
        "packages/worker-keystore": 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("countTestFiles — the walk never leaves the root", () => {
  it("does NOT follow a symlinked directory", () => {
    // The incident in one assertion. `outside/` holds a test file; `server/linked`
    // points at it. A walk that resolves the link reports 2 and would keep reporting
    // a healthy count after the real files were destroyed.
    const { root, write } = fixture();
    try {
      write("server/src/a.test.ts");
      write("outside/src/stolen.test.ts");
      mkdirSync(path.join(root, "server", "linked"), { recursive: true });
      rmSync(path.join(root, "server", "linked"), { recursive: true });
      symlinkSync(path.join(root, "outside"), path.join(root, "server", "linked"), LINK_TYPE);
      const counts = countTestFiles(root);
      assert.equal(counts.server, 1, "a followed link would make this 2");
      assert.equal(counts.outside, 1, "the real directory is still counted once, on its own");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not count a symlinked FILE", (t) => {
    const { root, write } = fixture();
    try {
      write("server/src/a.test.ts");
      try {
        symlinkSync(
          path.join(root, "server", "src", "a.test.ts"),
          path.join(root, "server", "src", "alias.test.ts"),
          "file",
        );
      } catch (error) {
        // Windows refuses FILE symlinks without Developer Mode or elevation, while
        // directory junctions (used above) need neither. Skipping is stated rather
        // than silently passing an assertion that never ran; the required Linux lane
        // executes it for real.
        t.skip(`cannot create a file symlink here: ${error.code}`);
        return;
      }
      assert.equal(countTestFiles(root).server, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a directory named __proto__ as ORDINARY DATA", () => {
    // Tree names come from the filesystem. On a plain object `counts["__proto__"] = 1`
    // sets the prototype instead of a key: the count silently vanishes and the tree
    // becomes invisible to the guard. The null-prototype accumulator is what prevents
    // that, so it is pinned here against a future tidy-up.
    const { root, write } = fixture();
    try {
      write("__proto__/a.test.ts");
      const counts = countTestFiles(root);
      assert.equal(counts.__proto__, 1);
      assert.equal(Object.getPrototypeOf(counts), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("countTestFiles — vendored trees are not the suite", () => {
  it("skips node_modules and build output wherever they appear", () => {
    const { root, write } = fixture();
    try {
      write("server/src/a.test.ts");
      write("server/node_modules/pkg/x.test.js");
      write("server/dist/y.test.js");
      write("node_modules/.pnpm/z.test.js");
      assert.deepEqual({ ...countTestFiles(root) }, { server: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty inventory for a missing root rather than throwing", () => {
    assert.deepEqual({ ...countTestFiles(path.join(os.tmpdir(), "aoa-inv-does-not-exist")) }, {});
  });
});
