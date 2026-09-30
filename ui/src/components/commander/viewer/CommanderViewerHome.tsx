import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import type { CommanderOutputRef, ShowRef } from "@armyofagents/shared";
import { artifactsApi } from "../../../api/artifacts";
import { chipLabel } from "./commanderViewerModel";

interface CommanderViewerHomeProps {
  companyId: string;
  conversationRefs: ShowRef[];
  onOpen: (ref: ShowRef) => void;
}

function RefRow({
  refItem,
  onOpen,
  note,
}: {
  refItem: ShowRef;
  onOpen: (r: ShowRef) => void;
  note?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(refItem)}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted/50"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{chipLabel(refItem)}</span>
      {note && <span className="shrink-0 text-[10px] text-muted-foreground">{note}</span>}
    </button>
  );
}

export function CommanderViewerHome({
  companyId,
  conversationRefs,
  onOpen,
}: CommanderViewerHomeProps) {
  const { data: recent } = useQuery({
    queryKey: ["commander-viewer-recent-artifacts", companyId],
    queryFn: () => artifactsApi.listByCompany(companyId),
    staleTime: 30_000,
    enabled: !!companyId,
  });

  const recentRefs: CommanderOutputRef[] = (recent ?? []).slice(0, 15).map((a) => ({
    v: 1,
    kind: "artifact",
    id: a.id,
    versionId: a.currentVersionId,
    title: a.title,
    action: "referenced",
  }));

  const empty = conversationRefs.length === 0 && recentRefs.length === 0;

  return (
    <div
      className="flex h-full flex-col gap-4 overflow-y-auto p-3"
      data-testid="commander-viewer-home"
    >
      {empty && (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
          Nothing yet — ask Commander to draft something.
        </p>
      )}
      {conversationRefs.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recent from this conversation
          </h3>
          {conversationRefs.map((r) => (
            <RefRow
              key={`${r.v}|${r.kind}|${r.id}|${r.versionId ?? "latest"}`}
              refItem={r}
              onOpen={onOpen}
              note={r.action === "created" ? "created here" : undefined}
            />
          ))}
        </section>
      )}
      {recentRefs.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recent in company
          </h3>
          {recentRefs.map((r) => (
            <RefRow key={r.id} refItem={r} onOpen={onOpen} />
          ))}
        </section>
      )}
    </div>
  );
}
