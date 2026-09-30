import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  sanitizeErrorText,
  serializeSafeError,
} from "../services/safe-error.js";

describe("safe marketplace error logging", () => {
  it("strips credentials, URL secrets, and absolute paths", () => {
    const text = sanitizeErrorText(
      "Bearer top-secret https://user:pass@example.com/file?sig=secret#frag " +
        "C:\\Users\\founder\\private\\SKILL.md " +
        "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    );
    expect(text).not.toContain("top-secret");
    expect(text).not.toContain("user:pass");
    expect(text).not.toContain("sig=secret");
    expect(text).not.toContain("founder");
    expect(text).not.toContain("sk-ant-api03");
    expect(text).toContain("https://example.com/file");
  });

  it("keeps the Pino sink free of raw causes", async () => {
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const log = pino({ level: "debug" }, sink);
    const cause = new Error(
      "token=super-secret at https://example.com/file?signed=secret",
    );
    const error = new Error(
      "failed reading /app/.aoa/marketplace-skills/company/private",
      { cause },
    );

    log.error({ error: serializeSafeError(error) }, "reconcile failure");
    await new Promise<void>((resolve) => sink.end(resolve));

    expect(() => JSON.parse(output.trim())).not.toThrow();
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain("signed=secret");
    expect(output).not.toContain("/app/.aoa");
    expect(output).not.toContain(cause.message);
    expect(output).toContain("causeClass");
  });
});
