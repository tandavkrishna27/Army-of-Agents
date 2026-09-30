/**
 * useComposerMention — shared typed-@ + button-picker mention state for
 * plain-textarea composer surfaces (Workspace chatbar, Task Comments).
 *
 * Approved mock v2: every composer's @ works the same way — the @ button
 * opens the picker (first item preselected, Enter picks), and a trailing
 * `@token` in the text opens the same list inline. Discussion and Commander
 * already have richer inline engines (people+users, contenteditable tokens);
 * this hook brings the remaining surfaces up to the same contract with the
 * company's agents as mention targets (the server wakes @mentioned agents on
 * task/workspace comments — issues.ts findMentionedAgents).
 *
 * RANGE-BASED (review findings F1/F2/F9, 2026-07-16): the hook tracks the
 * exact {start, end} of the live token from the caret-anchored refresh —
 * select() replaces THAT range (never a regex against the end of the whole
 * value), and the menu closes automatically whenever the input value changes
 * through any path the hook didn't drive (send-clear, programmatic reset).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import type { MentionOption } from "./ComposerMentionMenu";

/**
 * Detect an `@token` immediately before the caret (start-or-whitespace
 * boundary, same rule as EntryComposer/threads). Returns the token AND its
 * range so the caller can replace exactly what the user typed.
 */
export function detectTrailingMention(
  text: string,
  caret: number,
): { token: string; start: number; end: number } | null {
  const upToCaret = text.slice(0, caret);
  const match = /(^|\s)@([\w-]*)$/.exec(upToCaret);
  if (!match) return null;
  const token = match[2];
  return { token, start: caret - token.length - 1, end: caret };
}

export interface UseComposerMentionArgs {
  companyId: string | null | undefined;
  /** Current input value + a setter that also re-focuses the input. */
  value: string;
  onChange: (next: string) => void;
  /** Focus the underlying input and place the caret at `pos`. */
  focusAt: (pos: number) => void;
}

export function useComposerMention({ companyId, value, onChange, focusAt }: UseComposerMentionArgs) {
  // Single source of truth: a non-null range = menu open on that token.
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // The last value the hook itself saw/produced. Any other change to the
  // input (send cleared it, a draft restore, etc.) closes the menu — a
  // lingering popover over text it no longer describes is finding F2.
  const lastSeenValueRef = useRef(value);

  useEffect(() => {
    if (value !== lastSeenValueRef.current) {
      lastSeenValueRef.current = value;
      setRange(null);
    }
  }, [value]);

  const open = range !== null;

  // Server-side @mention resolution on comments matches org + aoa agents
  // (issues.ts findMentionedAgents) — offer the same set in the picker.
  const { data: agents = [], isLoading, isFetching } = useQuery({
    queryKey: ["composer-mention-agents", companyId],
    queryFn: async () => {
      const [org, aoa] = await Promise.all([
        agentsApi.list(companyId as string),
        agentsApi.listAoa(companyId as string).catch(() => []),
      ]);
      const seen = new Set<string>();
      return [...org, ...aoa].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
    },
    enabled: !!companyId && open,
    staleTime: 60_000,
  });

  const options: MentionOption[] = useMemo(
    () =>
      (agents as Array<{ id: string; name: string; status?: string; icon?: string | null }>)
        .filter((a) => a.status !== "terminated")
        // `includes`, not `startsWith` — Discussion and Commander both match
        // anywhere in the name; the surfaces must behave identically (F5).
        .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8)
        .map((a) => ({ id: a.id, name: a.name, type: "agent" as const, icon: a.icon ?? null })),
    [agents, query],
  );

  /** Re-evaluate on every text/caret change (wire to onChange AND onSelect). */
  const refresh = useCallback((text: string, caret: number) => {
    lastSeenValueRef.current = text;
    const hit = detectTrailingMention(text, caret);
    if (!hit) {
      setRange(null);
      return;
    }
    setQuery(hit.token);
    setIndex(0);
    setRange({ start: hit.start, end: hit.end });
  }, []);

  /** @ button: append "@" (space-separated) and open the picker on it. */
  const openViaButton = useCallback(() => {
    const next = value.length === 0 || /\s$/.test(value) ? `${value}@` : `${value} @`;
    lastSeenValueRef.current = next;
    onChange(next);
    setQuery("");
    setIndex(0);
    setRange({ start: next.length - 1, end: next.length });
    requestAnimationFrame(() => focusAt(next.length));
  }, [value, onChange, focusAt]);

  /** Replace the tracked token range with the picked mention. */
  const select = useCallback(
    (option: MentionOption) => {
      if (!range) return;
      // Clamp defensively — the value may have grown/shrunk since the range
      // was captured (we close on external changes, but belt-and-braces).
      const start = Math.min(range.start, value.length);
      const end = Math.min(range.end, value.length);
      const inserted = `@${option.name} `;
      const next = `${value.slice(0, start)}${inserted}${value.slice(end)}`;
      lastSeenValueRef.current = next;
      onChange(next);
      setRange(null);
      requestAnimationFrame(() => focusAt(start + inserted.length));
    },
    [range, value, onChange, focusAt],
  );

  /** Keyboard contract while open: ↑/↓ navigate, Enter picks, Esc closes. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" && options.length > 0) {
        e.preventDefault();
        select(options[index] ?? options[0]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setRange(null);
        return true;
      }
      return false;
    },
    [open, options, index, select],
  );

  return {
    open,
    options,
    // Teammates still loading (F8): the menu shows a "Loading teammates…" row
    // instead of a misleading "No matches" while the agents query is in flight.
    // A background refetch with cached agents is NOT loading — the list is
    // already showing real options and must not flicker into the loading row.
    loading: open && (isLoading || (isFetching && agents.length === 0)),
    index,
    setIndex,
    refresh,
    openViaButton,
    select,
    handleKeyDown,
    close: () => setRange(null),
  };
}
