import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCapped,
  buildScrubbedCliEnv,
  newCappedBuffer,
} from "../services/cli-spawn-safety.js";

// ── buildScrubbedCliEnv ──────────────────────────────────────────────────────

describe("buildScrubbedCliEnv", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // Start from a clean, known env for each case.
    for (const k of Object.keys(process.env)) delete process.env[k];
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/aoa";
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("keeps benign env (PATH/HOME) the CLI needs to run", () => {
    const env = buildScrubbedCliEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/aoa");
  });

  it("drops the server's own secrets (AOA_*, infra creds, generic secrets)", () => {
    process.env.AOA_AGENT_JWT_SECRET = "shh";
    process.env.AOA_INSTANCE_ID = "inst-1";
    process.env.GITHUB_PAT = "ghp_xxx";
    process.env.DATABASE_URL = "postgres://x";
    process.env.STRIPE_SECRET = "sk_live";
    process.env.SOME_PASSWORD = "p";

    const env = buildScrubbedCliEnv();
    expect(env.AOA_AGENT_JWT_SECRET).toBeUndefined();
    expect(env.AOA_INSTANCE_ID).toBeUndefined();
    expect(env.GITHUB_PAT).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STRIPE_SECRET).toBeUndefined();
    expect(env.SOME_PASSWORD).toBeUndefined();
  });

  it("drops generic token / api-key / access-key / credential-style vars (P1 re-review)", () => {
    process.env.NPM_TOKEN = "npm_x";
    process.env.SENTRY_AUTH_TOKEN = "sentry_x";
    process.env.AWS_ACCESS_KEY_ID = "AKIA...";
    process.env.AWS_SECRET_ACCESS_KEY = "wJal...";
    process.env.SLACK_API_KEY = "xoxb-...";
    process.env.SESSION_COOKIE = "abc";
    process.env.SOME_CREDENTIAL = "c";

    const env = buildScrubbedCliEnv();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.SENTRY_AUTH_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SLACK_API_KEY).toBeUndefined();
    expect(env.SESSION_COOKIE).toBeUndefined();
    expect(env.SOME_CREDENTIAL).toBeUndefined();
    // …but benign operational env the CLI needs survives.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/aoa");
  });

  it("drops ALL vendor auth keys by default", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.GEMINI_API_KEY = "g";

    const env = buildScrubbedCliEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("re-adds only the vendor auth key the caller keeps (claude keeps ANTHROPIC)", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";

    const env = buildScrubbedCliEnv(["ANTHROPIC_API_KEY"]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-anthropic");
    // The embeddings OpenAI key must NOT reach a claude child.
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("re-adds only the explicitly-kept vendor auth key, dropping the rest", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";

    // The keep mechanism is generic; only the named key survives. (codex
    // extraction now keeps NONE — it authenticates via the copied auth.json.)
    const env = buildScrubbedCliEnv(["OPENAI_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ── appendCapped ─────────────────────────────────────────────────────────────

describe("appendCapped", () => {
  it("accumulates text under the cap and reports not-capped", () => {
    const buf = newCappedBuffer();
    const tripped = appendCapped(buf, Buffer.from("hello"), 100);
    expect(tripped).toBe(false);
    expect(buf.text).toBe("hello");
    expect(buf.capped).toBe(false);
  });

  it("trips once the cap is exceeded and stops growing the text", () => {
    const buf = newCappedBuffer();
    appendCapped(buf, Buffer.from("aaaa"), 6); // 4 bytes, under cap
    const tripped = appendCapped(buf, Buffer.from("bbbb"), 6); // 8 bytes total, over cap
    expect(tripped).toBe(true);
    expect(buf.capped).toBe(true);
    // The overflowing chunk is dropped; text stays bounded at the pre-overflow value.
    expect(buf.text).toBe("aaaa");
    // Further chunks keep counting bytes but never grow the text.
    appendCapped(buf, Buffer.from("cccc"), 6);
    expect(buf.text).toBe("aaaa");
    expect(buf.bytes).toBe(12);
  });
});
