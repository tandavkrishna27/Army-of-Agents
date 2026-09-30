import { describe, expect, it } from "vitest";
import { parseCsv } from "../csv-parse";

describe("parseCsv (RFC-4180)", () => {
  it("parses a quoted field containing the delimiter (naive split would fail)", () => {
    const input = '"Smith, John",42';
    // Ablation: the previous naive parser did `line.split(",")`, which splits the
    // quoted comma and yields THREE cells instead of two.
    const naive = input.split(",").map((cell) => cell.trim());
    expect(naive).toEqual(['"Smith', 'John"', "42"]); // demonstrably wrong
    // The RFC-4180 parser keeps the quoted field intact.
    expect(parseCsv(input)).toEqual([["Smith, John", "42"]]);
  });

  it("preserves a newline embedded inside a quoted field", () => {
    expect(parseCsv('"line1\nline2",b')).toEqual([["line1\nline2", "b"]]);
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    expect(parseCsv('"a""b",c')).toEqual([['a"b', "c"]]);
  });

  it("returns ragged rows verbatim (fewer and more cells than the header)", () => {
    expect(parseCsv("a,b,c\n1,2\n3,4,5,6")).toEqual([
      ["a", "b", "c"],
      ["1", "2"],
      ["3", "4", "5", "6"],
    ]);
  });

  it("returns an empty array for empty or blank-only input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n")).toEqual([]);
    expect(parseCsv("\r\n\r\n")).toEqual([]);
  });

  it("does not emit a spurious empty row for a trailing newline", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
    expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a field that is just an empty quoted string as an empty cell", () => {
    expect(parseCsv('x,"",z')).toEqual([["x", "", "z"]]);
  });

  it("trims unquoted whitespace but preserves whitespace inside quotes", () => {
    expect(parseCsv("a, b ,c")).toEqual([["a", "b", "c"]]);
    expect(parseCsv('"  padded  ",y')).toEqual([["  padded  ", "y"]]);
  });

  it("drops interior blank lines (single empty field) without collapsing empty cells", () => {
    // Blank physical line is dropped; a `,` row of two genuinely-empty cells is kept.
    expect(parseCsv("a\nb\n\nc")).toEqual([["a"], ["b"], ["c"]]);
    expect(parseCsv("x,y\n,\n1,2")).toEqual([
      ["x", "y"],
      ["", ""],
      ["1", "2"],
    ]);
  });

  it("parses tab-separated content with an explicit tab delimiter and does not split on commas", () => {
    // TSV is routed with a KNOWN delimiter (registry maps `.tsv` -> "\t"); no sniffing.
    expect(parseCsv("name\tcity\nSmith, John\tNYC", "\t")).toEqual([
      ["name", "city"],
      ["Smith, John", "NYC"],
    ]);
  });

  it("does not misparse a comma CSV whose field contains a literal tab (no sniffer to misfire)", () => {
    // A tab inside a quoted CSV field must not change the delimiter — the sniffer that
    // could have done that was removed; the caller-supplied comma is authoritative.
    expect(parseCsv('"a\tb",c\n1,2')).toEqual([
      ["a\tb", "c"],
      ["1", "2"],
    ]);
    // ...and an unquoted tab in a comma CSV is just a literal character in the cell.
    expect(parseCsv("Col\tA,Col2\nx,y")).toEqual([
      ["Col\tA", "Col2"],
      ["x", "y"],
    ]);
  });

  it("unescapes a doubled quote at end of a quoted field (\"\"\"\" -> escaped quote)", () => {
    expect(parseCsv('"a""""b",c')).toEqual([['a""b', "c"]]);
    expect(parseCsv('""""')).toEqual([['"']]);
  });

  it("degrades sanely on an unterminated quote (no hang; remaining text is the final field)", () => {
    expect(parseCsv('"abc')).toEqual([["abc"]]);
    expect(parseCsv('a,"bc')).toEqual([["a", "bc"]]);
  });

  it("strips a leading UTF-8 BOM even when the first cell is quoted", () => {
    // Unquoted first cell — trim would have hidden the BOM anyway.
    expect(parseCsv("﻿Name,City\nBob,NYC")[0][0]).toBe("Name");
    // Quoted first cell — the old blanket trim did NOT reach inside quotes, so the BOM
    // survived as an invisible zero-width char. stripBom must remove it up front.
    expect(parseCsv('﻿"Name","City"\nBob,NYC')).toEqual([
      ["Name", "City"],
      ["Bob", "NYC"],
    ]);
  });
});
