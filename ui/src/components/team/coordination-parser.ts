// Client-side mirror of server/src/services/coordination-parser.ts.
// Keep in sync. Tests for the canonical version live server-side.

const BEGIN_RE = /<!--\s*begin:auto:([\w-]+)\s*-->/g;

export type CoordinationSection =
  | { kind: "user"; content: string }
  | { kind: "auto"; name: string; content: string };

export function parseCoordinationSections(markdown: string): CoordinationSection[] {
  const sections: CoordinationSection[] = [];
  let pos = 0;
  BEGIN_RE.lastIndex = 0;

  while (pos < markdown.length) {
    BEGIN_RE.lastIndex = pos;
    const m = BEGIN_RE.exec(markdown);
    if (!m) {
      const trailing = markdown.slice(pos).replace(/\n+$/, "");
      if (trailing.length > 0) sections.push({ kind: "user", content: trailing });
      break;
    }
    if (m.index > pos) {
      const u = markdown.slice(pos, m.index).replace(/\n+$/, "");
      if (u.length > 0) sections.push({ kind: "user", content: u });
    }
    const name = m[1];
    const contentStart = m.index + m[0].length;
    const endRe = new RegExp(`<!--\\s*end:auto:${name}\\s*-->`);
    const tail = markdown.slice(contentStart);
    const endMatch = endRe.exec(tail);
    if (!endMatch) throw new Error(`unmatched begin marker for "${name}"`);
    const endAbs = contentStart + endMatch.index;
    sections.push({
      kind: "auto",
      name,
      content: markdown.slice(contentStart, endAbs).replace(/^\n+|\n+$/g, ""),
    });
    pos = endAbs + endMatch[0].length;
    while (pos < markdown.length && markdown[pos] === "\n") pos++;
  }
  return sections;
}

export function serializeSections(sections: CoordinationSection[]): string {
  return sections
    .map((s) => {
      if (s.kind === "user") return s.content;
      return `<!-- begin:auto:${s.name} -->\n${s.content}\n<!-- end:auto:${s.name} -->`;
    })
    .join("\n\n");
}
