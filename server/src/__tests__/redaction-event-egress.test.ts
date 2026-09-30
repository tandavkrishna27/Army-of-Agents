import { describe, it, expect } from "vitest";
import {
  redactEventPayload,
  redactRunEventPayload,
  REDACTED_EVENT_VALUE,
} from "../redaction.js";

// A real Anthropic-key shape. Kept in one constant so a test cannot pass because
// the fixture drifted into something the patterns happen not to match.
const SECRET = "sk-ant-abcdefghijklmnop123456";
const dump = (value: unknown) => JSON.stringify(value);

describe("BRW-003d-2 FIX A — a secret in an ARRAY ELEMENT must not survive", () => {
  it("redacts a secret held as an array element", () => {
    // ★ THE LIVE DEFECT. `sanitizeValue` recurses into arrays, but a STRING falls
    // through `if (!isPlainObject(value)) return value` untouched — and only
    // `sanitizeRecord` tests string values, and only for values it reaches as a
    // RECORD ENTRY. An array element is never a record entry, so it skipped both
    // the key-name check and the value-pattern check.
    //
    // `args` arrays are exactly what process / claude_local adapter configs carry,
    // and this redactor serves agent.adapterConfig and the run-event payloads
    // behind GET /heartbeat-runs/:runId/events.
    const out = redactEventPayload({ args: ["--token", SECRET] });
    expect(dump(out)).not.toContain(SECRET);
    expect(dump(out)).toContain(REDACTED_EVENT_VALUE);
  });

  it("treats the same secret identically whether nested in an object or an array", () => {
    // The defect is an ASYMMETRY, so the test asserts the symmetry directly
    // rather than each half separately.
    const inObject = dump(redactEventPayload({ cfg: { thing: SECRET } }));
    const inArray = dump(redactEventPayload({ cfg: [SECRET] }));
    expect(inObject).not.toContain(SECRET);
    expect(inArray).not.toContain(SECRET);
  });

  it("redacts a secret nested deeply through arrays of arrays", () => {
    const out = redactEventPayload({ argv: [["--k", [SECRET]]] });
    expect(dump(out)).not.toContain(SECRET);
  });

  it("leaves ordinary array strings alone", () => {
    // Redacting more is the right default for a security control, but not so much
    // more that the payload stops being readable.
    const out = redactEventPayload({ args: ["--verbose", "build", "./src"] });
    expect(dump(out)).not.toContain(REDACTED_EVENT_VALUE);
    expect(out).toEqual({ args: ["--verbose", "build", "./src"] });
  });
});

describe("BRW-003d-2 FIX B — structural URL redaction on the event egress", () => {
  it("strips a query string carrying an UNRECOGNISABLE token", () => {
    // The point of structural stripping: `abc123` matches no secret pattern,
    // because it is shaped like nothing. Pattern-based redaction cannot catch it;
    // structure can.
    const out = redactRunEventPayload({ url: "https://ex.com/cb?access_token=abc123&x=1" });
    expect(dump(out)).not.toContain("abc123");
    expect(dump(out)).not.toContain("access_token");
  });

  it("keeps scheme, host and path so the URL stays diagnostically useful", () => {
    const out = redactRunEventPayload({ url: "https://ex.com/a/b?t=s3cret" }) as Record<string, string>;
    expect(out.url).toContain("https://ex.com/a/b");
    expect(out.url).not.toContain("s3cret");
  });

  it("signals that a query was withheld rather than silently vanishing", () => {
    // An operator who sees a bare URL concludes it had no parameters. A marker is
    // the difference between "nothing here" and "something here you may not see".
    const withQuery = redactRunEventPayload({ url: "https://ex.com/a?t=1" }) as Record<string, string>;
    const without = redactRunEventPayload({ url: "https://ex.com/a" }) as Record<string, string>;
    expect(withQuery.url).not.toBe(without.url);
  });

  it("strips a fragment", () => {
    const out = redactRunEventPayload({ href: "https://ex.com/p#id_token=zzz" });
    expect(dump(out)).not.toContain("zzz");
    expect(dump(out)).not.toContain("id_token");
  });

  it("strips userinfo credentials", () => {
    const out = redactRunEventPayload({ location: "https://user:hunter2@ex.com/p" });
    expect(dump(out)).not.toContain("hunter2");
  });

  it("is KEY-AGNOSTIC — the frozen forbidden-key scan is keys-only, so values must be swept", () => {
    // wire-safety's forbidden-key scan looks at KEYS. A credential sitting in a
    // value under an innocuous key is legal on the wire, which is why this pass
    // cannot be keyed on a name list.
    for (const key of ["url", "href", "location", "target", "somethingElse"]) {
      const out = redactRunEventPayload({ [key]: "https://ex.com/x?tok=leakme" });
      expect(dump(out), `key ${key}`).not.toContain("leakme");
    }
  });

  it("sweeps URLs nested in objects and arrays, not just at the top level", () => {
    const out = redactRunEventPayload({
      nav: [{ to: "https://ex.com/a?tok=leakme" }],
      deep: { inner: { at: "https://ex.com/b#tok=leakme2" } },
    });
    expect(dump(out)).not.toContain("leakme");
    expect(dump(out)).not.toContain("leakme2");
  });

  it("finds a URL embedded in a longer message", () => {
    // Console lines and log messages carry URLs mid-sentence; a whole-value URL
    // test would miss every one of them.
    const out = redactRunEventPayload({
      message: "navigated to https://ex.com/cb?code=leakme then idled",
    }) as Record<string, string>;
    expect(out.message).not.toContain("leakme");
    expect(out.message).toContain("navigated to");
    expect(out.message).toContain("then idled");
  });

  it("★ fails CLOSED when the URL will not parse", () => {
    // The catch path had no test and a mutant survived because of it: making the
    // fallback `return raw` left everything green. That is the branch that runs
    // for exactly the inputs most likely to be hostile — a malformed authority
    // that `new URL` refuses. It must still cut the query, not hand it back.
    for (const malformed of [
      "http://[::1?token=leakme",
      "https://%%%/x?token=leakme",
      "https://ex.com:port/x?token=leakme",
    ]) {
      expect(() => new URL(malformed)).toThrow(); // the premise of the test
      const out = redactRunEventPayload({ url: malformed }) as Record<string, string>;
      expect(out.url, malformed).not.toContain("leakme");
    }
  });

  it("leaves prose without URLs untouched", () => {
    const text = "resolved 12 modules in 1.2s (no network)";
    expect(redactRunEventPayload({ message: text })).toEqual({ message: text });
  });

  it("still applies the pattern-based redaction it composes with", () => {
    const out = redactRunEventPayload({ args: ["--token", SECRET] });
    expect(dump(out)).not.toContain(SECRET);
  });
});

describe("BRW-003d-2 — the URL pass is deliberately NOT global", () => {
  it("★ leaves a config URL's query intact", () => {
    // redactEventPayload also serves adapterConfig / runtimeConfig / approvals /
    // activity details. An http adapter's webhook URL has a legitimate query
    // string; stripping it globally would corrupt what operators see rather than
    // secure it. This assertion is what makes the narrower scope a DECISION
    // rather than an omission — if someone moves the URL pass into the shared
    // path, this goes red and they have to mean it.
    //
    // NOTE ON THE FIXTURE: `webhookUrl` would be the obvious choice and is the
    // WRONG one — `webhook` is already in SECRET_PAYLOAD_KEY_RE, so that key is
    // redacted wholesale by name and proves nothing about the URL pass. `baseUrl`
    // matches no key pattern, so it isolates exactly the behaviour under test.
    const out = redactEventPayload({
      baseUrl: "https://api.example.com/v1?workspace=abc&mode=fast",
    }) as Record<string, string>;
    expect(out.baseUrl).toBe("https://api.example.com/v1?workspace=abc&mode=fast");
  });

  it("★ but the EVENT path does strip the same value", () => {
    // The pair is what makes the scoping a decision: identical input, two entry
    // points, deliberately different results.
    const out = redactRunEventPayload({
      baseUrl: "https://api.example.com/v1?workspace=abc&mode=fast",
    }) as Record<string, string>;
    expect(out.baseUrl).not.toContain("workspace=abc");
    expect(out.baseUrl).toContain("https://api.example.com/v1");
  });
});
