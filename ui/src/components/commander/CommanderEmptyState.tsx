import { Clock, MessageSquare } from "lucide-react";
import { timeAgo } from "../../lib/timeAgo";
import type { ConversationRow } from "../../api/internal-agent";

const PROMPT_CHIPS = [
  "What happened while I was away?",
  "Show me blocked tasks",
  "Summarize today's progress",
  "What needs my approval?",
] as const;

interface CommanderEmptyStateProps {
  greetingText?: string;
  onPromptClick: (text: string) => void;
  recentChats: ConversationRow[];
  onSelectChat: (id: string) => void;
}

export function CommanderEmptyState({
  greetingText,
  onPromptClick,
  recentChats,
  onSelectChat,
}: CommanderEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 py-8 gap-6 text-center">
      {/* Greeting heading */}
      <div className="space-y-1.5">
        <h2 className="text-[1.05rem] font-semibold text-text">
          {greetingText ?? "How can I help you today?"}
        </h2>
        <p className="text-xs text-dim max-w-xs">
          Ask me about your tasks, goals, agents, or anything across your workspace.
        </p>
      </div>

      {/* Prompt chips */}
      <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
        {PROMPT_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => onPromptClick(chip)}
            className="px-3 py-2.5 rounded-lg border border-border bg-card text-[0.78rem] text-dim hover:bg-hd hover:text-text hover:border-border-strong transition-colors text-left leading-snug"
          >
            {chip}
          </button>
        ))}
      </div>

      {/* Recent chats */}
      {recentChats.length > 0 && (
        <div className="w-full max-w-sm space-y-1">
          <p className="text-[0.65rem] font-semibold text-very-dim uppercase tracking-widest text-left px-1 mb-1.5">
            Recent
          </p>
          {recentChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => onSelectChat(chat.id)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-card hover:bg-hd hover:border-border-strong transition-colors text-left"
            >
              <MessageSquare className="h-3.5 w-3.5 text-very-dim shrink-0" />
              <span className="flex-1 min-w-0 text-[0.8rem] text-dim truncate">
                {chat.title ?? "Untitled chat"}
              </span>
              <span className="flex items-center gap-1 text-[0.68rem] text-very-dim font-mono shrink-0">
                <Clock className="h-3 w-3" />
                {timeAgo(chat.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
