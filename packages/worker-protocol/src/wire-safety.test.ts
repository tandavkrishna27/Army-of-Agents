import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FORBIDDEN_WIRE_KEYS,
  addForbiddenWireKeyIssues,
  clearRegisteredSecretCanaries,
  createSeededRng,
  findForbiddenWireKeys,
  findSecretCanaryStringMatches,
  generateWireStringSample,
  getRegisteredSecretCanaries,
  normalizeWireKey,
  registerSecretCanaries,
  visitWireStrings,
} from "./wire-safety.js";

// -----------------------------------------------------------------------------
// Recursive forbidden-key detection (plaintext-credential containment).
// -----------------------------------------------------------------------------

describe("wire safety", () => {
  it("finds credential-bearing keys recursively", () => {
    expect(
      findForbiddenWireKeys({
        future: { apiKey: "x" },
        oauth: { accessToken: "y", refreshToken: "z" },
        rows: [{ password: "w" }],
      }),
    ).toEqual(["future.apiKey", "oauth.accessToken", "oauth.refreshToken", "rows.0.password"]);
  });

  it("does not reject opaque handle identifiers", () => {
    expect(findForbiddenWireKeys({ secretHandleIds: ["id"], policyHash: "hash" })).toEqual([]);
  });
});

describe("forbidden wire-key normalization", () => {
  it("locks the exact normalized forbidden set", () => {
    expect([...FORBIDDEN_WIRE_KEYS].sort()).toEqual(
      [
        "env",
        "environment",
        "apikey",
        "password",
        "token",
        "accesstoken",
        "refreshtoken",
        "cookie",
        "authorization",
        "credential",
        "credentials",
        "secretvalue",
      ].sort(),
    );
  });

  it("normalizes by lowercasing and stripping punctuation + underscores", () => {
    expect(normalizeWireKey("accessToken")).toBe("accesstoken");
    expect(normalizeWireKey("access_token")).toBe("accesstoken");
    expect(normalizeWireKey("Access-Token")).toBe("accesstoken");
    expect(normalizeWireKey("API_KEY")).toBe("apikey");
    expect(normalizeWireKey("Authorization")).toBe("authorization");
    expect(normalizeWireKey("secret_value")).toBe("secretvalue");
    expect(normalizeWireKey("secretHandleIds")).toBe("secrethandleids");
  });

  it("catches every credential spelling case-insensitively after normalization", () => {
    expect(
      findForbiddenWireKeys({
        Env: "1",
        environment: "2",
        API_KEY: "3",
        Password: "4",
        Token: "5",
        "access-token": "6",
        refresh_token: "7",
        Cookie: "8",
        Authorization: "9",
        credential: "10",
        credentials: "11",
        secret_value: "12",
      }).length,
    ).toBe(12);
  });

  it("only matches whole normalized keys, not substrings", () => {
    // policyHash / secretHandleIds / myToken are NOT forbidden — only exact
    // normalized matches against the locked set are.
    expect(findForbiddenWireKeys({ policyHash: "h", secretHandleIds: ["a"], myToken: "t" })).toEqual(
      [],
    );
  });

  it("reports deterministic sorted dotted paths including array indices", () => {
    expect(
      findForbiddenWireKeys({
        z: { cookie: "c" },
        a: [{ token: "t" }, { env: "e" }],
      }),
    ).toEqual(["a.0.token", "a.1.env", "z.cookie"]);
  });
});

describe("addForbiddenWireKeyIssues", () => {
  const guarded = z.unknown().superRefine((value, ctx) => {
    addForbiddenWireKeyIssues(value, ctx);
  });

  it("adds a custom issue at every offending path", () => {
    const result = guarded.safeParse({ oauth: { accessToken: "y" }, rows: [{ password: "w" }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = result.error.issues;
    expect(issues.every((issue) => issue.code === z.ZodIssueCode.custom)).toBe(true);
    const paths = issues.map((issue) => issue.path.join(".")).sort();
    expect(paths).toEqual(["oauth.accessToken", "rows.0.password"]);
  });

  it("accepts a clean object", () => {
    expect(guarded.safeParse({ secretHandleIds: ["id"], policyHash: "h" }).success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Pure recursive string visitor / secret-canary scanning.
// -----------------------------------------------------------------------------

describe("visitWireStrings", () => {
  it("visits every string value across nested objects and arrays", () => {
    const seen: Array<[string, string]> = [];
    visitWireStrings(
      { a: "one", b: ["two", { c: "three" }], d: 5, e: true, f: null },
      (value, path) => {
        seen.push([path, value]);
      },
    );
    expect(seen.sort()).toEqual(
      [
        ["a", "one"],
        ["b.0", "two"],
        ["b.1.c", "three"],
      ].sort(),
    );
  });
});

describe("secret canary scanning", () => {
  it("registers and clears canaries", () => {
    clearRegisteredSecretCanaries();
    registerSecretCanaries(["SECRET_ABC", ""]);
    expect(getRegisteredSecretCanaries().has("SECRET_ABC")).toBe(true);
    // Empty strings are never registered (would match everything).
    expect(getRegisteredSecretCanaries().has("")).toBe(false);
    clearRegisteredSecretCanaries();
    expect(getRegisteredSecretCanaries().size).toBe(0);
  });

  it("finds a registered canary embedded as a substring of any string value", () => {
    clearRegisteredSecretCanaries();
    registerSecretCanaries(["CANARY_TOKEN_ZZZ"]);
    const matches = findSecretCanaryStringMatches({
      workload: { args: ["--flag", "--auth=CANARY_TOKEN_ZZZ-tail"] },
      note: "clean",
    });
    expect(matches).toEqual(["workload.args.1"]);
    clearRegisteredSecretCanaries();
  });

  it("returns no matches for a clean structure", () => {
    expect(findSecretCanaryStringMatches({ a: "clean", b: ["also", "fine"] }, ["NOPE"])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Seeded deterministic generator — the ≥10,000-case producer secret-scan corpus.
// Seed + count are recorded in the PRT-003 ledger.
// -----------------------------------------------------------------------------

const CANARY_CORPUS_SEED = 20260809;
const CANARY_CORPUS_COUNT = 10_000;
const CORPUS_CANARY = "CANARY_a1b2c3d4e5f6_SECRETVALUE";

describe("seeded wire-string corpus generator", () => {
  it("is deterministic for a fixed seed", () => {
    const a = createSeededRng(CANARY_CORPUS_SEED);
    const b = createSeededRng(CANARY_CORPUS_SEED);
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    expect(seqA).toEqual(seqB);
    // Different seeds diverge.
    const c = createSeededRng(CANARY_CORPUS_SEED + 1);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(seqA);
  });

  it("inspects every string across ≥10,000 recursive cases; registered canaries always fail", () => {
    clearRegisteredSecretCanaries();
    registerSecretCanaries([CORPUS_CANARY]);

    const rng = createSeededRng(CANARY_CORPUS_SEED);
    let inspectedStrings = 0;
    let benignChecked = 0;
    let canaryChecked = 0;

    for (let i = 0; i < CANARY_CORPUS_COUNT; i += 1) {
      // Benign sample: covers argv, URLs, headers, nested arrays, and extensions.
      const benign = generateWireStringSample(rng);
      let localStrings = 0;
      visitWireStrings(benign.sample, () => {
        localStrings += 1;
      });
      expect(localStrings).toBeGreaterThan(0);
      inspectedStrings += localStrings;
      // A benign sample never trips a canary or a forbidden key.
      expect(findSecretCanaryStringMatches(benign.sample)).toEqual([]);
      expect(findForbiddenWireKeys(benign.sample)).toEqual([]);
      benignChecked += 1;

      // Canary sample: the registered secret is spliced into exactly one string.
      const tainted = generateWireStringSample(rng, CORPUS_CANARY);
      expect(tainted.canaryPath).not.toBeNull();
      const hits = findSecretCanaryStringMatches(tainted.sample);
      expect(hits).toContain(tainted.canaryPath);
      canaryChecked += 1;
    }

    expect(benignChecked).toBe(CANARY_CORPUS_COUNT);
    expect(canaryChecked).toBe(CANARY_CORPUS_COUNT);
    expect(inspectedStrings).toBeGreaterThanOrEqual(CANARY_CORPUS_COUNT);
    clearRegisteredSecretCanaries();
  });
});
