import {it, expect, beforeEach} from "vitest";
import {readLayoutJournal, writeLayoutJournal, clearForeignLayoutJournals, journalKey} from "./layout-journal";
const scope = JSON.stringify(["owner", "company", "conversation"]);
const entry = () => ({pending: [{baseRevision: 0, operations: [{type: "viewport" as const, x: 1, y: 2, zoom: 1}]}], uncertain: null, conflict: null, revisionFloor: 0, resolvedRemoteBase: 0});
beforeEach(() => sessionStorage.clear());
it("round trips only valid owner-scoped operations", () => {
 writeLayoutJournal(sessionStorage, scope, entry());
 expect(readLayoutJournal(sessionStorage, scope)).toEqual(entry());
 expect(readLayoutJournal(sessionStorage, "different")).toBeNull();
});
it("rejects a 101st group without replacing the recoverable journal", () => {
 const data = entry(); data.pending = Array.from({length: 100}, () => entry().pending[0]!);
 writeLayoutJournal(sessionStorage, scope, data);
 expect(() => writeLayoutJournal(sessionStorage, scope, {...data, pending: [...data.pending, ...entry().pending]})).toThrow();
 expect(readLayoutJournal(sessionStorage, scope)?.pending).toHaveLength(100);
});
it("clears foreign accounts but preserves the current account and unrelated storage", () => {
 writeLayoutJournal(sessionStorage, scope, entry());
 const other = JSON.stringify(["other", "company", "conversation"]);
 writeLayoutJournal(sessionStorage, other, entry()); sessionStorage.setItem("unrelated", "keep");
 clearForeignLayoutJournals(sessionStorage, "owner");
 expect(sessionStorage.getItem(journalKey(other))).toBeNull();
 expect(readLayoutJournal(sessionStorage, scope)).not.toBeNull();
 expect(sessionStorage.getItem("unrelated")).toBe("keep");
});
it("rejects corrupted or expired storage rather than replaying it", () => {
 sessionStorage.setItem(journalKey(scope), '{"version":999}');
 expect(() => readLayoutJournal(sessionStorage, scope)).toThrow();
 writeLayoutJournal(sessionStorage, scope, entry(), 0);
 expect(readLayoutJournal(sessionStorage, scope, 86400001)).toBeNull();
});

it("rejects the UTF-8 byte cap without replacing the previous journal", () => {
 writeLayoutJournal(sessionStorage, scope, entry());
 const open = {type: "open" as const, key: "panel", ref: {kind: "task" as const, id: "task"}, title: "界".repeat(1024), rect: {x: 0, y: 0, width: 300, height: 200}};
 const large = {...entry(), pending: Array.from({length: 40}, () => ({baseRevision: 0, operations: Array.from({length: 10}, () => open)}))};
 expect(() => writeLayoutJournal(sessionStorage, scope, large)).toThrow(/1 MiB/);
 expect(readLayoutJournal(sessionStorage, scope)).toEqual(entry());
});

it("preserves property witnesses across reload and rejects malformed witnesses", () => {
 const data = {...entry(), pending: [{...entry().pending[0]!, witnesses: ["[0,0,1]"]}]};
 writeLayoutJournal(sessionStorage, scope, data);
 expect(readLayoutJournal(sessionStorage, scope)).toEqual(data);
 for (const witnesses of [[], ["x".repeat(16385)], [false]]) {
   const invalid = {...data, pending: [{...data.pending[0]!, witnesses}]};
   expect(() => writeLayoutJournal(sessionStorage, scope, invalid as unknown as Parameters<typeof writeLayoutJournal>[2])).toThrow();
   expect(readLayoutJournal(sessionStorage, scope)).toEqual(data);
 }
});
