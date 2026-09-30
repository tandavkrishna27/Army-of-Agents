import assert from "node:assert/strict";
import test from "node:test";

import {
  EgressPolicyVectorError,
  IPV6_PRIVATE_CIDRS,
  NETWORK_DENIAL_CLASSES,
  classifyEgress,
  ipInCidr,
  isPrivateIp,
  loadFixture,
  parseIp,
  verifyFixture,
} from "./check-egress-policy-vectors.mjs";

const ALLOW = [{ host: "api.notion.com", port: 443 }];
const CP = ["45.55.0.0/16", "2606:1234::/32"];

test("the checked-in fixture passes the reference checker", () => {
  const { allows, denies } = verifyFixture(loadFixture());
  assert.ok(allows >= 4);
  assert.ok(denies >= 10);
});

test("NETWORK_DENIAL_CLASSES is exactly the four frozen classes", () => {
  assert.deepEqual([...NETWORK_DENIAL_CLASSES].sort(), ["control_plane", "metadata", "not_allowlisted", "private"]);
});

test("allowlist gate: https allowlisted public host is allowed", () => {
  assert.equal(classifyEgress("https://api.notion.com/v1", ["104.18.0.1"], ALLOW, CP), "allow");
});

test("allowlist gate: non-allowlisted / non-https / wrong-port / unparseable → not_allowlisted", () => {
  assert.equal(classifyEgress("https://evil.example/x", ["104.18.0.1"], ALLOW, CP), "not_allowlisted");
  assert.equal(classifyEgress("http://api.notion.com/v1", ["104.18.0.1"], ALLOW, CP), "not_allowlisted");
  assert.equal(classifyEgress("https://api.notion.com:9000/v1", ["104.18.0.1"], ALLOW, CP), "not_allowlisted");
  assert.equal(classifyEgress("nope", ["104.18.0.1"], ALLOW, CP), "not_allowlisted");
});

test("IP gate: rebind to private / metadata / control-plane classes", () => {
  assert.equal(classifyEgress("https://api.notion.com/v1", ["10.0.0.1"], ALLOW, CP), "private");
  assert.equal(classifyEgress("https://api.notion.com/v1", ["169.254.169.254"], ALLOW, CP), "metadata");
  assert.equal(classifyEgress("https://api.notion.com/v1", ["45.55.9.9"], ALLOW, CP), "control_plane");
});

test("IP gate: deny if ANY resolved address is unsafe (multi-homed rebind)", () => {
  assert.equal(classifyEgress("https://api.notion.com/v1", ["104.18.0.1", "127.0.0.1"], ALLOW, CP), "private");
});

test("IP gate: empty resolution is fail-closed private", () => {
  assert.equal(classifyEgress("https://api.notion.com/v1", [], ALLOW, CP), "private");
});

test("precedence: metadata > control_plane > private", () => {
  assert.equal(classifyEgress("https://api.notion.com/v1", ["169.254.169.254", "45.55.1.1"], ALLOW, CP), "metadata");
  // 198.51.100.x is TEST-NET-2 (private) AND a control-plane range → control_plane wins.
  assert.equal(classifyEgress("https://api.notion.com/v1", ["198.51.100.5"], ALLOW, ["198.51.100.0/24"]), "control_plane");
});

test("ipInCidr + parseIp handle v4, v6, and mapped forms", () => {
  assert.equal(ipInCidr("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(ipInCidr("11.1.2.3", "10.0.0.0/8"), false);
  assert.equal(ipInCidr("2606:1234:5::1", "2606:1234::/32"), true);
  assert.equal(parseIp("::ffff:169.254.169.254").family, 4);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("verifyFixture throws when an allow vector is mutated to resolve private", () => {
  const fixture = structuredClone(loadFixture());
  fixture.allowVectors[0].resolvedAddrs = ["10.0.0.1"];
  assert.throws(() => verifyFixture(fixture), EgressPolicyVectorError);
});

test("verifyFixture throws when a deny vector's expected class is wrong", () => {
  const fixture = structuredClone(loadFixture());
  const target = fixture.denyVectors.find((v) => v.name === "cloud_metadata_imds");
  target.class = "private";
  assert.throws(() => verifyFixture(fixture), EgressPolicyVectorError);
});

// --- W17: the IPv6 half of the oracle ----------------------------------------
//
// This oracle's IPv6 half used to deny only 7 ranges — a strict SUBSET of the
// production predicate it is supposed to disagree with. These cases pin the
// widened list AS THIS FILE'S OWN PROPERTY. They deliberately do NOT compare
// against `isPrivateIP`: that comparison lives in
// `server/src/__tests__/w17-ipv6-range-closeout.test.ts`, which can import both,
// and importing production HERE would destroy this file's independence.

test("W17 IPv6: every registry range the oracle claims is actually denied", () => {
  for (const [ip, why] of [
    ["::1", "loopback"],
    ["::169.254.169.254", "IPv4-compatible spelling of IMDS"],
    ["64:ff9b::169.254.169.254", "RFC6052 NAT64 well-known prefix carrying IMDS"],
    ["64:ff9b:1::1", "RFC8215 NAT64 local-use prefix"],
    ["100::1", "RFC6666 discard-only"],
    ["100:0:0:1::1", "RFC9780 Dummy Prefix"],
    ["2001::1", "RFC4380 Teredo"],
    ["2001:2::1", "RFC5180 benchmarking"],
    ["2001:10::1", "RFC4843 ORCHID (deprecated)"],
    ["2001:20::1", "RFC7343 ORCHIDv2"],
    ["2001:db8::1", "RFC3849 documentation"],
    ["2002:a9fe:a9fe::1", "RFC3056 6to4 carrying IMDS"],
    ["3fff::1", "RFC9637 documentation"],
    ["5f00::1", "RFC9602 SRv6 SIDs"],
    ["fc00::1", "RFC4193 unique-local"],
    ["fd12:3456::1", "RFC4193 unique-local"],
    ["fe80::1", "link-local"],
    ["fec0::1", "deprecated site-local"],
    ["ff02::1", "multicast"],
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} (${why})`);
  }
});

test("W17 IPv6: THE POSITIVE CONTROL — real destinations stay allowed", () => {
  // A predicate that denied everything would pass the case above. These are the
  // address families AoA's real destinations live in.
  for (const ip of [
    "2606:4700:4700::1111", // Cloudflare DNS
    "2001:4860:4860::8888", // Google DNS
    "2600:1f18::1", // AWS
    "2a00:1450:4001::1", // Google
    "2620:4f:8000::1", // AS112 direct delegation — inside NO denied range
    "2001:1::1", // RFC7723 PCP anycast — Globally Reachable = TRUE
    "2001:1::2", // RFC8155 TURN anycast — Globally Reachable = TRUE
    "2001:3::1", // RFC7450 AMT — Globally Reachable = TRUE
    "2001:4:112::1", // RFC7535 AS112-v6 — Globally Reachable = TRUE
    "2001:30::1", // RFC9374 DRIP DETs — Globally Reachable = TRUE
    "2003::1", // ordinary global unicast just past 2002::/16
    "3ffe::1", // 6bone, returned to the free pool; NOT reserved today
    "5f01::1", // just past 5f00::/16
    "100:0:0:2::1", // just past the Dummy Prefix
  ]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("W17 IPv6: the 2001::/23 remainder is deliberately NOT denied", () => {
  // The IETF Protocol Assignments superblock reads Globally Reachable = False, but
  // its assigned sub-blocks outside the ranges above read TRUE. Covering the /23
  // would deny real routed destinations to close nothing. This case exists so that
  // "add 2001::/23, it's in the registry" is a RED test rather than a code review.
  assert.equal(IPV6_PRIVATE_CIDRS.includes("2001::/23"), false);
  for (const ip of ["2001:1::1", "2001:3::1", "2001:4:112::1", "2001:30::1"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("W17 IPv6: the CIDR list is exactly the 17 registry-derived entries", () => {
  assert.deepEqual(IPV6_PRIVATE_CIDRS, [
    "::/16",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "100:0:0:1::/64",
    "2001::/32",
    "2001:2::/48",
    "2001:10::/28",
    "2001:20::/28",
    "2001:db8::/32",
    "2002::/16",
    "3fff::/20",
    "5f00::/16",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
  ]);
});
