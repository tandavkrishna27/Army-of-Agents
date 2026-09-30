import { describe, expect, it } from "vitest";

import { createWorkerLogger } from "../logging/logger.js";

/** A pino destination that captures each written line. */
function capture() {
  const lines: string[] = [];
  return {
    lines,
    records: () => lines.map((l) => JSON.parse(l)),
    stream: { write: (chunk: string) => void lines.push(chunk) },
  };
}

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----AAAA-fake-ed25519-secret-BBBB-----END PRIVATE KEY-----";
const SESSION_TOKEN = "sess_live_9f8e7d6c5b4a3210-secret";
const RAW_CODE = "ENROLL-CODE-4242-RAW-SECRET";

describe("createWorkerLogger — redaction guard", () => {
  it("drops private key / session token / raw enrollment code fields", () => {
    const cap = capture();
    const logger = createWorkerLogger({ destination: cap.stream });

    logger.info(
      {
        workerId: "wrk_abc",
        privateKey: PRIVATE_KEY,
        sessionToken: SESSION_TOKEN,
        enrollmentCode: RAW_CODE,
      },
      "enrolled",
    );

    const whole = cap.lines.join("");
    expect(whole).not.toContain(PRIVATE_KEY);
    expect(whole).not.toContain(SESSION_TOKEN);
    expect(whole).not.toContain(RAW_CODE);

    const [record] = cap.records();
    // Opaque IDs survive; secrets are redacted (not merely absent-by-accident).
    expect(record.workerId).toBe("wrk_abc");
    expect(record.privateKey).not.toBe(PRIVATE_KEY);
    expect(record.sessionToken).not.toBe(SESSION_TOKEN);
    expect(record.enrollmentCode).not.toBe(RAW_CODE);
  });

  it("redacts sensitive fields nested inside objects and arrays", () => {
    const cap = capture();
    const logger = createWorkerLogger({ destination: cap.stream });

    logger.info(
      {
        correlationId: "corr_1",
        auth: { authorization: "Bearer " + SESSION_TOKEN, deviceGeneration: 4 },
        proofs: [{ signature: "sig-" + PRIVATE_KEY }],
      },
      "poll",
    );

    const whole = cap.lines.join("");
    expect(whole).not.toContain(SESSION_TOKEN);
    expect(whole).not.toContain(PRIVATE_KEY);
    // Opaque IDs and generations remain visible for debuggability.
    expect(whole).toContain("corr_1");
    expect(whole).toContain("deviceGeneration");
  });

  it("preserves opaque IDs and passes plain string messages through", () => {
    const cap = capture();
    const logger = createWorkerLogger({ destination: cap.stream });

    logger.info(
      {
        workerId: "wrk_1",
        targetId: "tgt_2",
        deviceGeneration: 7,
        correlationId: "corr_9",
        leaseId: "lease_3",
        sandboxId: "sbx_4",
      },
      "starting",
    );
    logger.info("plain message");

    const [structured, plain] = cap.records();
    expect(structured.workerId).toBe("wrk_1");
    expect(structured.targetId).toBe("tgt_2");
    expect(structured.deviceGeneration).toBe(7);
    expect(structured.leaseId).toBe("lease_3");
    expect(structured.sandboxId).toBe("sbx_4");
    expect(plain.msg).toBe("plain message");
  });

  it("still serializes an Error passed as { err }", () => {
    const cap = capture();
    const logger = createWorkerLogger({ destination: cap.stream });
    logger.error({ err: new Error("health server close failed"), step: "health-server" }, "shutdown step failed");
    const [record] = cap.records();
    expect(record.step).toBe("health-server");
    expect(JSON.stringify(record)).toContain("health server close failed");
  });
});

describe("DSK-001/D7 — raw bytes never print, whatever the field is called", () => {
  // The redactor is NAME-based, and that is exactly the hole here. A device
  // private key is a Uint8Array; under a key the list does not match — `blob`,
  // `der`, `payload`, `record` — it serializes to an object of numeric indices
  // and the key prints in full as a list of digits. No amount of naming
  // discipline in future call sites fixes that; the type does.
  //
  // Plan §4/D7. One line, and it closes the hazard structurally.

  function logged(bindings: Record<string, unknown>): string {
    const chunks: string[] = [];
    const logger = createWorkerLogger({
      destination: { write: (c: string) => { chunks.push(c); } },
    });
    logger.error(bindings, "diagnostic");
    return chunks.join("");
  }

  it("masks a Uint8Array under an INNOCENT key name", () => {
    const der = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]);
    const text = logged({ blob: der });
    // The give-away is the index-keyed serialization of the bytes.
    expect(text).not.toContain('"0":48');
    expect(text).toContain("[bytes]");
  });

  it("masks bytes nested inside an ordinary object", () => {
    const text = logged({ record: { workerId: "w-1", der: new Uint8Array([1, 2, 3]) } });
    expect(text).not.toContain('"0":1');
    expect(text).toContain("[bytes]");
    // The surrounding diagnostic must survive.
    expect(text).toContain("w-1");
  });

  it("masks an ArrayBuffer as well as a view over one", () => {
    const text = logged({ buf: new ArrayBuffer(8) });
    expect(text).toContain("[bytes]");
  });

  it("leaves ordinary arrays of numbers alone", () => {
    // The guard must key on the TYPE, not on "looks like numbers" — a plain
    // array of counts is a legitimate diagnostic.
    const text = logged({ counts: [1, 2, 3] });
    expect(text).not.toContain("[bytes]");
    expect(text).toContain("3");
  });
});
