// ui/src/components/workspace/transcript/TranscriptMessageBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "../../MarkdownBody";

interface TranscriptMessageBlockProps {
  role: "assistant" | "user";
  text: string;
  streaming: boolean;
  ts?: string;
  className?: string;
}

const MAX_COLLAPSED_LENGTH = 500;

export function TranscriptMessageBlock({
  role,
  text,
  streaming,
  className,
}: TranscriptMessageBlockProps) {
  const [showFull, setShowFull] = useState(false);
  const truncated = !showFull && text.length > MAX_COLLAPSED_LENGTH;
  const displayText = truncated ? `${text.slice(0, MAX_COLLAPSED_LENGTH)}...` : text;

  if (role === "user") {
    return null; // User messages handled by TimelineUserMessage
  }

  return (
    <div className={cn("px-1 py-1.5", className)} data-testid="transcript-message-block">
      {streaming && (
        <div className="mb-1">
          <span className="text-xs text-muted-foreground animate-pulse">Thinking</span>
        </div>
      )}
      <div className="text-sm leading-6 text-foreground">
        <MarkdownBody>{displayText}</MarkdownBody>
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowFull(true)}
          className="mt-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Show more
        </button>
      )}
    </div>
  );
}
