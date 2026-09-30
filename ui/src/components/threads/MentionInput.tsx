/**
 * MentionInput — controlled input that extracts @mentions as chips.
 *
 * Usage:
 *   <MentionInput chips={chips} onChipsChange={setChips} />
 *
 * Behavior:
 * - Type @word then press Enter or Space to create a chip
 * - Chips are displayed as colored tokens above/below the input
 * - Actual resolution to agent/user happens server-side via processMentions
 */

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MentionInputProps {
  chips: string[];
  onChipsChange: (chips: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function MentionInput({
  chips,
  onChipsChange,
  placeholder = "@mention someone...",
  className,
}: MentionInputProps) {
  const [inputValue, setInputValue] = useState("");

  function tryExtractMention(value: string): string | null {
    // Match @word at the start or after whitespace, followed by word chars
    const match = value.match(/(?:^|\s)(@\w+)(?:\s|$)/);
    return match ? match[1] : null;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === " ") {
      const mention = tryExtractMention(inputValue);
      if (mention && !chips.includes(mention)) {
        onChipsChange([...chips, mention]);
        setInputValue("");
        e.preventDefault();
      }
    }
    // Backspace on empty input removes last chip
    if (e.key === "Backspace" && inputValue === "" && chips.length > 0) {
      onChipsChange(chips.slice(0, -1));
    }
  }

  function removeChip(chip: string) {
    onChipsChange(chips.filter((c) => c !== chip));
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0",
        className,
      )}
      data-testid="mention-input-container"
    >
      {/* Chips */}
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-800 dark:text-violet-300 px-2 py-0.5 text-[11px] font-medium"
          data-testid={`mention-chip-${chip.replace("@", "")}`}
        >
          {chip}
          <button
            type="button"
            onClick={() => removeChip(chip)}
            className="text-violet-600 hover:text-violet-900 dark:hover:text-violet-100"
            aria-label={`Remove ${chip}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}

      {/* Text input */}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={chips.length === 0 ? placeholder : undefined}
        className="flex-1 min-w-[120px] bg-transparent outline-none text-foreground placeholder:text-muted-foreground text-xs py-0.5"
        data-testid="mention-input"
        aria-label="Mention input"
      />
    </div>
  );
}
