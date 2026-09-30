import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock mammoth so we can inject an arbitrary HTML payload at the DOCX→HTML
// boundary and drive the REAL DOMPurify sanitize with it. A real DOCX cannot
// make mammoth emit scripts/handlers/unknown tags, so this is the only way to
// exercise the sanitizer against a hostile payload. DOMPurify runs for real.
const { mockConvert } = vi.hoisted(() => ({ mockConvert: vi.fn() }));
vi.mock("mammoth", () => ({ default: { convertToHtml: mockConvert } }));

import { renderDocxBufferToSafeHtml } from "../services/docx-render.js";
import {
  OFFICE_RENDER_MAX_BYTES,
  OfficeRenderTooLargeError,
} from "../services/office-render-limits.js";

async function sanitize(html: string): Promise<string> {
  mockConvert.mockResolvedValue({ value: html, messages: [] });
  return renderDocxBufferToSafeHtml(Buffer.from("ignored"));
}

describe("renderDocxBufferToSafeHtml — shared DOCX render+sanitize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps output in the docx-rendered article shell", async () => {
    const out = await sanitize("<p>hello</p>");
    expect(out).toMatch(/^<article class="docx-rendered">/);
    expect(out).toMatch(/<\/article>$/);
    expect(out).toContain("<p>hello</p>");
  });

  // Resource-exhaustion guard: a buffer over the render cap is refused BEFORE
  // mammoth parses it — mockConvert must never be called, proving the size check
  // short-circuits the unbounded parse.
  it("refuses a buffer over the render input cap without calling mammoth", async () => {
    const oversized = Buffer.alloc(OFFICE_RENDER_MAX_BYTES + 1);
    await expect(renderDocxBufferToSafeHtml(oversized)).rejects.toBeInstanceOf(
      OfficeRenderTooLargeError,
    );
    expect(mockConvert).not.toHaveBeenCalled();
  });

  // The items explicitly named in FORBID_TAGS / FORBID_ATTR.
  it("strips the explicitly-forbidden tags and event handlers", async () => {
    const out = await sanitize(
      [
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(2)">',
        '<iframe src="https://evil.example"></iframe>',
        '<object data="x"></object>',
        '<embed src="x">',
        "<form action=/x><input></form>",
        '<a href="javascript:alert(3)">click</a>',
        '<b onclick="x()">t</b>',
      ].join(""),
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toMatch(/<object/i);
    expect(out).not.toMatch(/<embed/i);
    expect(out).not.toMatch(/<form/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  // THE LOAD-BEARING GUARANTEE: the endpoint's safety comes from DOMPurify's
  // DEFAULT allow-list, not the FORBID_* lists. These payloads are NOT in either
  // FORBID list, so a deny-list-only sanitizer (or someone who "hardens" by only
  // trusting FORBID) would let them through. They must all be neutralized —
  // proving the default allow-list is the real boundary.
  it("neutralizes payloads that are NOT in the FORBID_* lists (default-deny guarantee)", async () => {
    const out = await sanitize(
      [
        '<a href="#" onmouseenter="alert(1)">hover</a>', // handler not in FORBID_ATTR
        "<details ontoggle=alert(1) open>x</details>", // handler not in FORBID_ATTR
        "<svg onload=alert(1)></svg>", // svg-context handler
        '<base href="http://evil.example/">', // tag not in FORBID_TAGS, not allow-listed
        '<meta http-equiv="refresh" content="0;url=http://evil.example">', // ditto
        '<a href="vbscript:msgbox(1)">v</a>', // non-http(s) scheme blocked by ALLOWED_URI_REGEXP
      ].join(""),
    );
    // No event handler of any name survives.
    expect(out).not.toMatch(/onmouseenter/i);
    expect(out).not.toMatch(/ontoggle/i);
    expect(out).not.toMatch(/onload/i);
    // Tags outside the default allow-list are dropped entirely.
    expect(out).not.toMatch(/<base/i);
    expect(out).not.toMatch(/<meta/i);
    expect(out).not.toMatch(/http-equiv/i);
    // Dangerous URI schemes are stripped by ALLOWED_URI_REGEXP.
    expect(out).not.toMatch(/vbscript:/i);
  });

  it("preserves benign https/mailto links and formatting (regression guard)", async () => {
    const out = await sanitize(
      '<p><a href="https://example.com">safe</a> <a href="mailto:a@b.com">mail</a> <strong>bold</strong></p>',
    );
    expect(out).toMatch(/href="https:\/\/example\.com"/);
    expect(out).toMatch(/href="mailto:a@b\.com"/);
    expect(out).toContain("<strong>bold</strong>");
  });
});
