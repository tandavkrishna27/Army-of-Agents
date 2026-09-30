const BEGIN_RE = /<!--\s*begin:auto:([\w-]+)\s*-->/g;

export type CoordinationSection =
  | { kind: "user"; content: string }
  | { kind: "auto"; name: string; content: string };

export function parseCoordinationSections(markdown: string): CoordinationSection[] {
  const sections: CoordinationSection[] = [];
  let pos = 0;

  // Reset regex state — module-level regex with /g preserves state across calls
  BEGIN_RE.lastIndex = 0;

  while (pos < markdown.length) {
    BEGIN_RE.lastIndex = pos;
    const beginMatch = BEGIN_RE.exec(markdown);

    if (!beginMatch) {
      const trailing = markdown.slice(pos).replace(/\n+$/, "");
      if (trailing.length > 0) sections.push({ kind: "user", content: trailing });
      break;
    }

    if (beginMatch.index > pos) {
      const userBlock = markdown.slice(pos, beginMatch.index).replace(/\n+$/, "");
      if (userBlock.length > 0) sections.push({ kind: "user", content: userBlock });
    }

    const name = beginMatch[1];
    const contentStart = beginMatch.index + beginMatch[0].length;

    // Check for nested begin marker before end marker
    BEGIN_RE.lastIndex = contentStart;
    const nextBegin = BEGIN_RE.exec(markdown);

    const endRe = new RegExp(`<!--\\s*end:auto:${name}\\s*-->`);
    const tail = markdown.slice(contentStart);
    const endMatch = endRe.exec(tail);

    if (!endMatch) throw new Error(`unmatched begin marker for "${name}"`);
    const endAbs = contentStart + endMatch.index;

    if (nextBegin && nextBegin.index < endAbs) {
      throw new Error(`nested auto markers inside "${name}"`);
    }

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

export function replaceAutoSection(
  markdown: string,
  name: string,
  newContent: string,
): string {
  const sections = parseCoordinationSections(markdown);
  const found = sections.some((s) => s.kind === "auto" && s.name === name);

  if (!found) {
    // Append the auto section to the end
    const trailing = markdown.endsWith("\n") ? "" : "\n";
    return `${markdown}${trailing}\n<!-- begin:auto:${name} -->\n${newContent}\n<!-- end:auto:${name} -->\n`;
  }

  return sections
    .map((s) => {
      if (s.kind === "user") return s.content;
      const content = s.name === name ? newContent : s.content;
      return `<!-- begin:auto:${s.name} -->\n${content}\n<!-- end:auto:${s.name} -->`;
    })
    .join("\n\n");
}
