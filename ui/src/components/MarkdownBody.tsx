import type { CSSProperties } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseProjectMentionHref, parseSkillMentionHref } from "@armyofagents/shared";
import { cn } from "../lib/utils";
import { useTheme } from "../context/ThemeContext";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  /**
   * When provided, clicks on external http(s) links call this instead of
   * navigating (e.g. Commander opens them in a sandboxed Browser viewer tab).
   * Mention chips and non-http(s) hrefs are never intercepted.
   */
  onLinkOpen?: (url: string) => void;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function mentionChipStyle(color: string | null): CSSProperties | undefined {
  if (!color) return undefined;
  const rgb = hexToRgb(color);
  if (!rgb) return undefined;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return {
    borderColor: color,
    backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`,
    color: luminance > 0.55 ? "#111827" : "#f8fafc",
  };
}

export function MarkdownBody({ children, className, onLinkOpen }: MarkdownBodyProps) {
  const { theme } = useTheme();
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none prose-p:my-2 prose-p:leading-[1.4] prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-li:leading-[1.4] prose-pre:my-2 prose-pre:whitespace-pre-wrap prose-pre:break-words prose-headings:my-2 prose-headings:text-sm prose-blockquote:leading-[1.4] prose-table:my-2 prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5 prose-code:break-all [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:list-item",
        theme === "dark" && "prose-invert",
        className,
      )}
    >
      {/*
  SECURITY INVARIANT: rehype-raw is intentionally absent.
  Commander output (parse-stream-json.ts plaintext fallback) is raw LLM text.
  Without rehype-raw, react-markdown escapes HTML tags — prevents XSS via prompt injection.
  Do NOT add rehype-raw without also adding rehype-sanitize with a strict allowlist.
  See: server/src/services/internal-agent/parse-stream-json.ts
*/}
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkChildren }) => {
            const parsedProject = href ? parseProjectMentionHref(href) : null;
            if (parsedProject) {
              return (
                <a
                  href={`/projects/${parsedProject.projectId}`}
                  className="aoa-project-mention-chip"
                  style={mentionChipStyle(parsedProject.color)}
                >
                  {linkChildren}
                </a>
              );
            }
            const parsedSkill = href ? parseSkillMentionHref(href) : null;
            if (parsedSkill) {
              return (
                <a
                  href={`#skill:${parsedSkill.skillId}`}
                  className="aoa-skill-mention-chip"
                >
                  {linkChildren}
                </a>
              );
            }
            if (onLinkOpen && href && (href.startsWith("http://") || href.startsWith("https://"))) {
              return (
                <a
                  href={href}
                  rel="noreferrer"
                  title={href}
                  className="cursor-pointer underline"
                  onClick={(e) => {
                    e.preventDefault();
                    onLinkOpen(href);
                  }}
                >
                  {linkChildren}
                </a>
              );
            }
            return (
              <a href={href} rel="noreferrer">
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
