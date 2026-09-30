/**
 * DSK-003 Lane A — provisioning the control token, and the thing it must never do.
 *
 * The host needs a token file to exist before any mutating command can be authorized. It
 * therefore creates one when absent — and the interesting behaviour is everything else:
 *
 *   NEVER REGENERATE OVER AN EXISTING TOKEN. An operator saves this value; silently
 *   minting a new one every boot would break every saved token on every restart, and the
 *   failure would look like "the token stopped working" rather than "the host replaced
 *   it".
 *
 *   NEVER REGENERATE OVER A MALFORMED ONE EITHER. That is the sharper case. A truncated
 *   or empty file is a fault, and quietly replacing it converts a fault into a silent
 *   credential rotation. `event-outbox-kek.ts` already carries this exact rule and its
 *   reason: it "NEVER silently regenerates over a corrupt key (that would orphan every
 *   existing row under a new key)". Here it would orphan the operator.
 *
 * So: absent → create. Present and well-formed → keep. Present and malformed → REFUSE.
 */

import { describe, expect, it, vi } from "vitest";

import { provisionControlToken } from "../control-token-provisioning.js";

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: Array<{ path: string; mode?: number }> = [];
  return {
    files,
    writes,
    io: {
      readFile: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      writeFile: (p: string, data: string, mode: number) => {
        files.set(p, data);
        writes.push({ path: p, mode });
      },
      mkdir: vi.fn(),
    },
  };
}

const PATH = "C:\\vault\\control-token.v1.txt";

describe("DSK-003 — an absent token is created", () => {
  it("mints a token and reports that it created one", () => {
    const fs = fakeFs();
    const result = provisionControlToken(PATH, fs.io as never);
    expect(result).toMatchObject({ ok: true, created: true });
    expect(fs.files.get(PATH)).toBeTruthy();
  });

  it("writes it owner-only", () => {
    // The whole authorization model is "can this caller read that file".
    const fs = fakeFs();
    provisionControlToken(PATH, fs.io as never);
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0]!.mode).toBe(0o600);
  });

  it("mints an unguessable, CLI-safe value", () => {
    const fs = fakeFs();
    provisionControlToken(PATH, fs.io as never);
    const token = fs.files.get(PATH)!.trim();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("mints a different token each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const fs = fakeFs();
      provisionControlToken(PATH, fs.io as never);
      seen.add(fs.files.get(PATH)!);
    }
    expect(seen.size).toBe(20);
  });
});

describe("DSK-003 — an existing token is never replaced", () => {
  const good = "x".repeat(43);

  it("keeps a well-formed token and writes nothing", () => {
    // An operator has this value saved. Minting a new one every boot would break every
    // saved token on every restart, and look like "the token stopped working".
    const fs = fakeFs({ [PATH]: good });
    const result = provisionControlToken(PATH, fs.io as never);
    expect(result).toMatchObject({ ok: true, created: false });
    expect(fs.files.get(PATH)).toBe(good);
    expect(fs.writes).toEqual([]);
  });

  it("REFUSES a malformed token rather than replacing it", () => {
    // The sharp case. Quietly replacing a truncated file converts a fault into a silent
    // credential rotation — the rule `event-outbox-kek.ts` already states for its KEK.
    for (const bad of ["", "   ", "short"]) {
      const fs = fakeFs({ [PATH]: bad });
      const result = provisionControlToken(PATH, fs.io as never);
      expect(result, JSON.stringify(bad)).toMatchObject({ ok: false, reason: "malformed_token_file" });
      expect(fs.writes, JSON.stringify(bad)).toEqual([]);
      expect(fs.files.get(PATH), JSON.stringify(bad)).toBe(bad); // untouched
    }
  });

  it("refuses when the file cannot be read for any other reason", () => {
    // EACCES is not absence. Treating an unreadable file as "no token" would mint a
    // second one beside a first nobody can see.
    const io = {
      readFile: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
      writeFile: () => { throw new Error("must not write"); },
      mkdir: vi.fn(),
    };
    expect(provisionControlToken(PATH, io as never))
      .toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("does not let whitespace PAD a short token to look valid", () => {
    // The case that makes `trim()` load-bearing, and the one the newline test below does
    // NOT cover: a 40-character token followed by three newlines is 43 raw characters. A
    // length check on the raw string accepts it; trimming first sees 40 and refuses. A
    // truncated write must not become valid by virtue of what follows it.
    const padded = `${"x".repeat(40)}${String.fromCharCode(10).repeat(3)}`;
    expect(padded.length).toBe(43); // raw length reaches the threshold
    const fs = fakeFs({ [PATH]: padded });
    expect(provisionControlToken(PATH, fs.io as never))
      .toMatchObject({ ok: false, reason: "malformed_token_file" });
    expect(fs.writes).toEqual([]);
  });

  it("tolerates a trailing newline on an existing token", () => {
    // Every shell redirect that writes one leaves it. Treating that as malformed would
    // refuse a perfectly good token.
    const fs = fakeFs({ [PATH]: `${good}\n` });
    expect(provisionControlToken(PATH, fs.io as never)).toMatchObject({ ok: true, created: false });
    expect(fs.writes).toEqual([]);
  });
});
