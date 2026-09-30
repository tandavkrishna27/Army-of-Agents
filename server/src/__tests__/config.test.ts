import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const ORIGINAL_AOA_TRUST_PROXY = process.env.AOA_TRUST_PROXY;
const ORIGINAL_AOA_EMBEDDED_POSTGRES_PORT = process.env.AOA_EMBEDDED_POSTGRES_PORT;

describe("loadConfig", () => {
  beforeEach(() => {
    delete process.env.AOA_TRUST_PROXY;
    delete process.env.AOA_EMBEDDED_POSTGRES_PORT;
  });

  afterEach(() => {
    if (ORIGINAL_AOA_TRUST_PROXY === undefined) {
      delete process.env.AOA_TRUST_PROXY;
    } else {
      process.env.AOA_TRUST_PROXY = ORIGINAL_AOA_TRUST_PROXY;
    }

    if (ORIGINAL_AOA_EMBEDDED_POSTGRES_PORT === undefined) {
      delete process.env.AOA_EMBEDDED_POSTGRES_PORT;
    } else {
      process.env.AOA_EMBEDDED_POSTGRES_PORT = ORIGINAL_AOA_EMBEDDED_POSTGRES_PORT;
    }
  });

  describe("trustProxy", () => {
    it("defaults to false when env var is unset", () => {
      expect(loadConfig().trustProxy).toBe(false);
    });

    it("defaults to false when env var is empty string", () => {
      process.env.AOA_TRUST_PROXY = "";
      expect(loadConfig().trustProxy).toBe(false);
    });

    it("parses true as true", () => {
      process.env.AOA_TRUST_PROXY = "true";
      expect(loadConfig().trustProxy).toBe(true);
    });

    it("parses false as false", () => {
      process.env.AOA_TRUST_PROXY = "false";
      expect(loadConfig().trustProxy).toBe(false);
    });

    it("parses integer string as number hop count", () => {
      process.env.AOA_TRUST_PROXY = "2";
      expect(loadConfig().trustProxy).toBe(2);
    });

    it("parses comma-separated CIDR list as array", () => {
      process.env.AOA_TRUST_PROXY = "10.0.0.0/8,192.168.0.0/16";
      expect(loadConfig().trustProxy).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    });

    it("trims whitespace in CIDR list entries", () => {
      process.env.AOA_TRUST_PROXY = " 10.0.0.0/8 , 192.168.0.0/16 ";
      expect(loadConfig().trustProxy).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    });

    it("rejects malformed input with an error naming the env var", () => {
      process.env.AOA_TRUST_PROXY = "not-a-number-or-cidr";
      expect(() => loadConfig()).toThrow(/AOA_TRUST_PROXY/);
    });
  });

  describe("embeddedPostgresPort", () => {
    it("allows an explicit embedded Postgres port env override", () => {
      process.env.AOA_EMBEDDED_POSTGRES_PORT = "55429";
      expect(loadConfig().embeddedPostgresPort).toBe(55429);
    });

    it("rejects an invalid embedded Postgres port env override", () => {
      process.env.AOA_EMBEDDED_POSTGRES_PORT = "not-a-port";
      expect(() => loadConfig()).toThrow(/AOA_EMBEDDED_POSTGRES_PORT/);
    });
  });
});
