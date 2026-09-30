import { ExternalLink } from "lucide-react";
import type { CompanySkillFileDetail } from "@armyofagents/shared";
import { MarkdownBody } from "../MarkdownBody";
import { MarkdownEditor } from "../MarkdownEditor";
import { Textarea } from "@/components/ui/textarea";

type ViewMode = "preview" | "code";

interface Props {
  file: CompanySkillFileDetail | null;
  editing: boolean;
  viewMode: ViewMode;
  draft: string;
  onDraftChange: (value: string) => void;
  /** External URL to view the file at its source (used when body isn't stored locally). */
  externalUrl?: string;
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

export function SkillBody({ file, editing, viewMode, draft, onDraftChange, externalUrl }: Props) {
  if (!file) {
    return (
      <div className="px-6 py-5 text-sm text-dim">Select a file to inspect.</div>
    );
  }

  // github / skills_sh skills only store SKILL.md content. For other paths,
  // file.content is empty and we surface a "View on GitHub" affordance.
  if (!editing && file.path !== "SKILL.md" && file.content === "" && externalUrl) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <p className="text-sm text-dim">
          File body isn't stored locally for managed skills.
        </p>
        <a
          href={externalUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-hd"
        >
          View on GitHub <ExternalLink className="size-3" />
        </a>
      </div>
    );
  }

  if (editing && file.editable) {
    if (file.markdown) {
      return (
        <div className="px-6 py-5">
          <MarkdownEditor
            value={draft}
            onChange={onDraftChange}
            bordered={false}
            className="min-h-[520px]"
          />
        </div>
      );
    }
    return (
      <div className="px-6 py-5">
        <Textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
        />
      </div>
    );
  }

  if (file.markdown && viewMode === "preview") {
    return (
      <div className="px-6 py-5">
        <MarkdownBody>{stripFrontmatter(file.content)}</MarkdownBody>
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-transparent px-6 py-5 font-mono text-sm text-text">
      <code>{file.content}</code>
    </pre>
  );
}
