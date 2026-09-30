import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export interface ReadmeRenderProps {
  source: string;
  className?: string;
}

/**
 * Renders trusted markdown using react-markdown with remark-gfm.
 *
 * react-markdown is XSS-safe by default — it does NOT render raw HTML embedded
 * in the markdown source (no rehype-raw plugin enabled). Wrapped in Tailwind
 * typography (`prose prose-sm`) for polished output. Marketplace READMEs are
 * trusted (curated repo + commit-pinned), but defense-in-depth prevents
 * surprises if community submissions land in future tiers.
 *
 * Distinct from `MarkdownBody`: that component lives inside the AoA app shell
 * (theme context + project/skill mention chip transforms). This one is a
 * standalone marketplace-only renderer with no app-context dependencies.
 */
export function ReadmeRender({ source, className }: ReadmeRenderProps) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none dark:prose-invert",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
