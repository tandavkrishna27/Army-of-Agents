import { describe, it, expect } from "vitest";
import { internalErrorLogFields } from "../utils/internal-error-log.js";

describe("internalErrorLogFields", () => {
  it("extracts a Postgres SQLSTATE code and the error class name", () => {
    const err = Object.assign(
      new Error("permission denied for table execution_targets"),
      { name: "PostgresError", code: "42501" },
    );
    expect(internalErrorLogFields(err)).toEqual({ errName: "PostgresError", errCode: "42501" });
  });

  it("reads the SQLSTATE off .cause.code when drizzle wraps the pg error", () => {
    // drizzle-orm wraps postgres-js errors: the outer wrapper has no .code, the
    // SQLSTATE lives on .cause.code (see services/db-errors.ts).
    const err = Object.assign(new Error("Failed query"), {
      name: "DrizzleQueryError",
      cause: Object.assign(new Error("permission denied"), { code: "42501" }),
    });
    expect(internalErrorLogFields(err)).toEqual({ errName: "DrizzleQueryError", errCode: "42501" });
  });

  it("prefers the top-level code over the cause code", () => {
    const err = Object.assign(new Error("x"), {
      name: "Error",
      code: "TOP",
      cause: Object.assign(new Error("y"), { code: "CAUSE" }),
    });
    expect(internalErrorLogFields(err)).toEqual({ errName: "Error", errCode: "TOP" });
  });

  it("captures an HTTP status for the HttpError family (no distinct name/code)", () => {
    const err = Object.assign(new Error("S3 presign endpoint must be https"), {
      name: "Error",
      status: 422,
    });
    expect(internalErrorLogFields(err)).toEqual({ errName: "Error", errStatus: 422 });
  });

  it("reads statusCode as an alternate status source", () => {
    const err = Object.assign(new Error("x"), { name: "Error", statusCode: 409 });
    expect(internalErrorLogFields(err)).toEqual({ errName: "Error", errStatus: 409 });
  });

  it("records the class name when there is no code (e.g. a ZodError)", () => {
    const err = Object.assign(new Error("Invalid input"), { name: "ZodError" });
    expect(internalErrorLogFields(err)).toEqual({ errName: "ZodError" });
  });

  it("stringifies a numeric code", () => {
    const err = Object.assign(new Error("boom"), { name: "Error", code: 500 });
    expect(internalErrorLogFields(err)).toEqual({ errName: "Error", errCode: "500" });
  });

  it("bounds an over-long custom error name so it cannot carry a payload", () => {
    const err = Object.assign(new Error("x"), { name: "N".repeat(500) });
    const out = internalErrorLogFields(err);
    expect(out.errName).toBe("N".repeat(200));
    expect(out.errName!.length).toBe(200);
  });

  it("records the JS type for a non-Error throw, never its value", () => {
    expect(internalErrorLogFields("SECRET_STRING_THROW")).toEqual({ errName: "string" });
    expect(internalErrorLogFields(42)).toEqual({ errName: "number" });
  });

  it("drops an over-long code and an out-of-range status so a payload cannot be smuggled", () => {
    expect(
      internalErrorLogFields(Object.assign(new Error("x"), { name: "Error", code: "x".repeat(65) })),
    ).toEqual({ errName: "Error" });
    expect(
      internalErrorLogFields(Object.assign(new Error("x"), { name: "Error", status: 99999 })),
    ).toEqual({ errName: "Error" });
    expect(
      internalErrorLogFields(Object.assign(new Error("x"), { name: "Error", status: 200.5 })),
    ).toEqual({ errName: "Error" });
  });

  // ★ JOB-002: the returned object must NEVER carry the message, nested cause
  // MESSAGE, SQL, or any value off the wire — only name + code + status. This holds
  // EVEN when the code is read off .cause.code (we take the cause's CODE, never its
  // message). Serialize and assert every sensitive marker is absent.
  it("never emits the message, cause message, SQL, or wire data (JOB-002)", () => {
    const err = Object.assign(
      new Error("SQL_INTERNAL_MESSAGE_MARKER INSERT INTO workers ($1)"),
      {
        name: "DrizzleQueryError",
        cause: Object.assign(
          new Error("SQL_INTERNAL_CAUSE_MARKER query parameters $1=secret"),
          { code: "42501" },
        ),
      },
    );
    const serialized = JSON.stringify(internalErrorLogFields(err));
    for (const marker of [
      "SQL_INTERNAL_MESSAGE_MARKER",
      "SQL_INTERNAL_CAUSE_MARKER",
      "INSERT INTO workers",
      "query parameters",
      "secret",
    ]) {
      expect(serialized, marker).not.toContain(marker);
    }
    // ...while still carrying the diagnostic classification from the cause code.
    expect(serialized).toContain("42501");
    expect(serialized).toContain("DrizzleQueryError");
  });
});
