import assert from "node:assert/strict";
import test from "node:test";

import { EgressPolicyVectorError, classifyEgress } from "./check-egress-policy-vectors.mjs";
import { loadFixture, verifyBypassFixture } from "./check-egress-bypass-vectors.mjs";

test("the checked-in egress-bypass fixture passes the reference checker", () => {
  const { allows, denies, controlPlaneVectors } = verifyBypassFixture(loadFixture());
  assert.ok(allows >= 2, `expected >= 2 allow vectors, got ${allows}`);
  assert.ok(denies >= 10, `expected >= 10 deny vectors, got ${denies}`);
  assert.ok(controlPlaneVectors >= 1, "expected >= 1 injected-control-plane vector");
});

test("hex-mapped IPv4-in-IPv6 metadata + control-plane spellings are canonicalized and denied", () => {
  const allow = [{ host: "api.notion.com", port: 443 }];
  const cp = ["45.55.0.0/16"];
  assert.equal(classifyEgress("https://api.notion.com/v1", ["::ffff:a9fe:a9fe"], allow, cp), "metadata");
  assert.equal(classifyEgress("https://api.notion.com/v1", ["::FFFF:A9FE:A9FE"], allow, cp), "metadata");
  assert.equal(classifyEgress("https://api.notion.com/v1", ["::ffff:2d37:6301"], allow, cp), "control_plane");
});

test("first-word-zero IPv6 + fail-closed non-dotted literals resolve private", () => {
  const allow = [{ host: "api.notion.com", port: 443 }];
  assert.equal(classifyEgress("https://api.notion.com/v1", ["::10"], allow, []), "private");
  assert.equal(classifyEgress("https://api.notion.com/v1", ["2130706433"], allow, []), "private");
  assert.equal(classifyEgress("https://api.notion.com/v1", ["0177.0.0.1"], allow, []), "private");
});

test("DNS-rebind [public,private] is denied if ANY resolved address is unsafe", () => {
  const allow = [{ host: "api.notion.com", port: 443 }];
  assert.equal(classifyEgress("https://api.notion.com/v1", ["104.18.32.7", "192.168.5.5"], allow, []), "private");
});

test("the injected control-plane deny set is load-bearing (empty set → the public IP would ALLOW)", () => {
  const allow = [{ host: "api.notion.com", port: 443 }];
  // WITH the injected CIDR → control_plane; WITHOUT it → allow (proves non-vacuity).
  assert.equal(classifyEgress("https://api.notion.com/v1", ["45.55.99.1"], allow, ["45.55.0.0/16"]), "control_plane");
  assert.equal(classifyEgress("https://api.notion.com/v1", ["45.55.99.1"], allow, []), "allow");
});

test("verifyBypassFixture throws when a deny vector's expected class is wrong", () => {
  const fixture = structuredClone(loadFixture());
  const target = fixture.denyVectors.find((v) => v.name === "metadata_hex_mapped_ipv6");
  target.class = "private";
  assert.throws(() => verifyBypassFixture(fixture), EgressPolicyVectorError);
});

test("verifyBypassFixture throws when a control_plane denial is not injection-dependent (vacuous)", () => {
  const fixture = structuredClone(loadFixture());
  // Point an injected-only vector at a LOOPBACK address: it would be denied `private`
  // even with an empty deny set, so it is no longer proving the injection is load-bearing.
  const target = fixture.denyVectors.find((v) => v.name === "control_plane_public_ipv4_injected_only");
  target.resolvedAddrs = ["127.0.0.1"];
  assert.throws(() => verifyBypassFixture(fixture), EgressPolicyVectorError);
});
