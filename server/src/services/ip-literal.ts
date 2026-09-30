// server/src/services/ip-literal.ts
//
// W13 — THE ONE IP-LITERAL PARSER. A leaf module with no imports.
//
// ★ WHY THIS FILE EXISTS: IT REDUCES THE PARSER COUNT, IT DOES NOT RAISE IT.
// Before this module the tree carried TWO parsers for the same grammar:
//   * `parseIpv6Words` in ./outbound-url-guard.ts — whose per-token regex FORBIDS
//     a dot, so `::169.254.169.254` never parsed, never reached the IPv6 range
//     checks, and `isPrivateIP` returned FALSE for the loopback-adjacent spelling
//     of the cloud metadata address (E8-F009 §4);
//   * `parseIpv4`/`parseIpv6Value`/`parseIp` in ./egress-policy.ts — which DOES
//     accept an embedded dotted quad and resolves that address correctly.
// Both are now DELETED and both modules import from here. The grammar has one
// implementation, so the two cannot diverge again by editing only one of them.
//
// ★ WHY IT IS A NEW FILE AND NOT A REUSE OF `egress-policy.parseIp`, MEASURED:
// `egress-policy.ts` IMPORTS `isPrivateIP` from `outbound-url-guard.ts` (:44).
// Importing `parseIp` the other way would close a cycle. The dependency direction
// physically forbids the reuse, so the shared grammar is lifted BELOW both instead
// — this module imports nothing, from anywhere.
//
// SCOPE: parsing only. No policy, no ranges, no verdicts. `isPrivateIP` owns the
// question "is this internal"; `ipInCidr` owns "is this in that block". A range
// rule added here would be a third policy, which is the disease this file treats.

/** An IP literal reduced to a family tag and its numeric value. */
export interface ParsedIp {
  readonly family: 4 | 6;
  readonly value: bigint;
}

/** Parse a dotted-quad IPv4 literal into its 32-bit value, or null. */
export function parseIpv4Value(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/**
 * Parse an IPv6 literal into its eight 16-bit words, or null.
 *
 * Handles `::` compression, a `%zone` suffix, `[…]` brackets, and — the fix this
 * module exists for — an EMBEDDED DOTTED QUAD (`::ffff:1.2.3.4`, `::1.2.3.4`,
 * `64:ff9b::169.254.169.254`), which contributes two words. The dotted token is
 * accepted anywhere a hextet is, matching the behaviour `egress-policy.parseIp`
 * has shipped with: the laxness is unreachable from the production call sites
 * (both guard on `node:net`'s `isIP` or on a resolver's own output first) and it
 * errs towards PARSING more, which can only ever add denials, never remove one.
 */
export function parseIpv6Words(ip: string): number[] | null {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0]!;
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (value: string): number[] | null => {
    if (!value) return [];
    const words: number[] = [];
    for (const token of value.split(":")) {
      if (token.includes(".")) {
        const v4 = parseIpv4Value(token);
        if (v4 === null) return null;
        words.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      words.push(Number.parseInt(token, 16));
    }
    return words;
  };

  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

/** The 128-bit value of eight 16-bit words. */
export function ipv6WordsToValue(words: readonly number[]): bigint {
  let value = 0n;
  for (const word of words) value = (value << 16n) | BigInt(word & 0xffff);
  return value;
}

/**
 * Parse an IP literal, unwrapping IPv4-mapped IPv6 (`::ffff:x.x.x.x` in either the
 * dotted or the HEX spelling) to IPv4 so a mapped address is classified with the
 * same authority as its IPv4 form — closing the family asymmetry that would
 * otherwise let a hex-mapped PUBLIC control-plane IP evade a family-4 gate.
 */
export function parseIp(ip: string): ParsedIp | null {
  const trimmed = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0]!;
  const mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4 = parseIpv4Value(mapped[1]!);
    return v4 === null ? null : { family: 4, value: v4 };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    const v4 = parseIpv4Value(trimmed);
    return v4 === null ? null : { family: 4, value: v4 };
  }
  const words = parseIpv6Words(trimmed);
  if (words === null) return null;
  const v6 = ipv6WordsToValue(words);
  if ((v6 >> 32n) === 0xffffn) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}
