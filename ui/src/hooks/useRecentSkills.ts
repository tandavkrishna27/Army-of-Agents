import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "aoa:skills:recent";
const MAX_ENTRIES = 5;

export interface RecentSkill {
  skillId: string;
  openedAt: number;
}

function readStorage(): RecentSkill[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentSkill =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RecentSkill).skillId === "string" &&
          typeof (entry as RecentSkill).openedAt === "number",
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeStorage(entries: RecentSkill[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded, private mode, etc. — silently drop.
  }
}

export function useRecentSkills() {
  const [recent, setRecent] = useState<RecentSkill[]>(() => readStorage());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setRecent(readStorage());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const recordOpen = useCallback((skillId: string) => {
    setRecent((current) => {
      const filtered = current.filter((r) => r.skillId !== skillId);
      const next: RecentSkill[] = [{ skillId, openedAt: Date.now() }, ...filtered].slice(
        0,
        MAX_ENTRIES,
      );
      writeStorage(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    writeStorage([]);
    setRecent([]);
  }, []);

  return { recent, recordOpen, clear };
}
