const UNTITLED_DISCUSSION_TITLE = "Untitled discussion";

const MAX_DERIVED_TITLE_CODE_POINTS = 80;

/** Resolve a new discussion's title from explicit input or its opening content. */
export function deriveDiscussionTitle(
  title?: string | null,
  openingContent?: string | null,
): string {
  const explicitTitle = title?.trim();
  if (explicitTitle) return explicitTitle;

  const firstMeaningfulLine = openingContent
    ?.split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .find(Boolean);

  if (!firstMeaningfulLine) return UNTITLED_DISCUSSION_TITLE;

  const codePoints = Array.from(firstMeaningfulLine);
  if (codePoints.length <= MAX_DERIVED_TITLE_CODE_POINTS) return firstMeaningfulLine;

  return `${codePoints.slice(0, MAX_DERIVED_TITLE_CODE_POINTS - 1).join("")}…`;
}

/** Provide a stable display name for old records or explicitly cleared titles. */
export function displayDiscussionTitle(title?: string | null): string {
  return title?.trim() || UNTITLED_DISCUSSION_TITLE;
}
