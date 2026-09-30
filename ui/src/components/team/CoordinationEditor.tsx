import { useState, useEffect, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Eye, Save, Settings as SettingsIcon, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { teamsApi } from "../../api/teams";
import { useCompany } from "../../context/CompanyContext";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import {
  parseCoordinationSections,
  serializeSections,
  type CoordinationSection,
} from "./coordination-parser";
import { PreviewAsLlmDialog } from "./PreviewAsLlmDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface Props {
  teamId: string;
  teamName: string;
}

export function CoordinationEditor({ teamId, teamName }: Props) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedSections, setEditedSections] = useState<CoordinationSection[] | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<CoordinationSection[] | null>(null);
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);

  const coordQuery = useQuery({
    queryKey: queryKeys.teams.coordination(selectedCompanyId!, teamId),
    queryFn: () => teamsApi.getCoordination(teamId),
    enabled: Boolean(selectedCompanyId && teamId),
  });

  useEffect(() => {
    if (coordQuery.data && editedSections === null) {
      try {
        setEditedSections(parseCoordinationSections(coordQuery.data.markdown));
      } catch {
        setEditedSections([{ kind: "user", content: coordQuery.data.markdown }]);
      }
    }
  }, [coordQuery.data, editedSections]);

  const saveMut = useMutation({
    mutationFn: () => {
      if (!editedSections) throw new Error("nothing to save");
      const markdown = serializeSections(editedSections);
      return teamsApi.upsertCoordination(teamId, `${teamName} Coordination`, markdown);
    },
    onSuccess: () => {
      pushToast({ title: "Coordination saved", tone: "success" });
      queryClient.invalidateQueries({
        queryKey: queryKeys.teams.coordination(selectedCompanyId!, teamId),
      });
      setIsEditing(false);
      setSavedSnapshot(null);
    },
    onError: (e) =>
      pushToast({ title: "Save failed", body: (e as Error).message, tone: "error" }),
  });

  const regenMut = useMutation({
    mutationFn: () => teamsApi.regenerateCoordination(teamId),
    onSuccess: () => {
      pushToast({ title: "Auto sections regenerated", tone: "success" });
      queryClient.invalidateQueries({
        queryKey: queryKeys.teams.coordination(selectedCompanyId!, teamId),
      });
      setEditedSections(null);
    },
    onError: (e) =>
      pushToast({ title: "Regenerate failed", body: (e as Error).message, tone: "error" }),
  });

  function handleEdit() {
    setSavedSnapshot(editedSections ? [...editedSections] : null);
    setIsEditing(true);
  }

  function handleCancel() {
    if (savedSnapshot) setEditedSections(savedSnapshot);
    setSavedSnapshot(null);
    setIsEditing(false);
  }

  const hasUnsavedEdits = useCallback(() => {
    return (
      isEditing &&
      editedSections !== null &&
      coordQuery.data != null &&
      serializeSections(editedSections) !== coordQuery.data.markdown
    );
  }, [isEditing, editedSections, coordQuery.data]);

  function handleRegen() {
    if (hasUnsavedEdits()) {
      setRegenConfirmOpen(true);
    } else {
      regenMut.mutate();
    }
  }

  if (coordQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading coordination...</p>;
  }

  if (coordQuery.isError || !coordQuery.data) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          No coordination found for this team yet.
        </p>
        <Button size="sm" onClick={() => regenMut.mutate()} disabled={regenMut.isPending}>
          <RotateCw className="h-3.5 w-3.5 mr-1" />
          Generate coordination
        </Button>
      </div>
    );
  }

  if (!editedSections) {
    return <p className="text-sm text-muted-foreground">Initializing...</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">coordination.md</h2>
          <p className="text-xs text-muted-foreground">
            Injected into every team member's system prompt
          </p>
        </div>
        <div className="flex gap-2">
          {isEditing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRegen}
                disabled={regenMut.isPending}
              >
                <RotateCw className="h-3.5 w-3.5 mr-1" />
                Regenerate auto sections
              </Button>
              <Button size="sm" variant="outline" onClick={handleCancel}>
                <X className="h-3.5 w-3.5 mr-1" />
                Cancel
              </Button>
              <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                <Save className="h-3.5 w-3.5 mr-1" />
                {saveMut.isPending ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}>
                <Eye className="h-3.5 w-3.5 mr-1" />
                Preview as LLM
              </Button>
              <Button size="sm" variant="outline" onClick={handleEdit}>
                <Pencil className="h-3.5 w-3.5 mr-1" />
                Edit
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        {editedSections.map((section, idx) => (
          <CoordinationSectionView
            key={idx}
            section={section}
            isEditing={isEditing}
            onChange={(next) => {
              const copy = [...editedSections];
              copy[idx] = next;
              setEditedSections(copy);
            }}
          />
        ))}
      </div>

      {isEditing && (
        <p className="text-[11px] text-muted-foreground">
          💡 <b>Auto sections</b> (purple-tinted) regenerate from team data — don't
          hand-edit; changes will be overwritten. <b>Your-edits sections</b>{" "}
          (white) are preserved across regen.
        </p>
      )}

      <PreviewAsLlmDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        markdown={serializeSections(editedSections)}
      />

      <ConfirmDialog
        open={regenConfirmOpen}
        onOpenChange={setRegenConfirmOpen}
        title="Regenerate auto sections?"
        description="You have unsaved edits. Regenerating will overwrite them with the latest team data."
        confirmLabel="Regenerate"
        destructive={false}
        onConfirm={() => regenMut.mutate()}
        disabled={regenMut.isPending}
      />
    </div>
  );
}

function CoordinationSectionView({
  section,
  isEditing,
  onChange,
}: {
  section: CoordinationSection;
  isEditing: boolean;
  onChange: (next: CoordinationSection) => void;
}) {
  if (section.kind === "user") {
    return (
      <div className="border-b last:border-b-0 p-3">
        {isEditing ? (
          <>
            <div className="mb-2">
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Your edits
              </span>
            </div>
            <Textarea
              value={section.content}
              onChange={(e) => onChange({ kind: "user", content: e.target.value })}
              rows={Math.max(3, section.content.split("\n").length + 1)}
              className="resize-y font-mono text-xs"
            />
          </>
        ) : (
          <pre className="whitespace-pre-wrap text-xs text-foreground">
            {section.content || <span className="text-muted-foreground italic">No custom instructions yet.</span>}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="border-b last:border-b-0 bg-indigo-50/30 dark:bg-indigo-950/10 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-wide text-indigo-600">
          <SettingsIcon className="h-2.5 w-2.5" />
          AUTO · {section.name.toUpperCase()}
        </span>
      </div>
      <pre className="whitespace-pre-wrap rounded bg-background/60 p-2 text-xs">
        {section.content}
      </pre>
      {isEditing && (
        <p className="mt-2 text-[10px] italic text-muted-foreground">
          ⚙ This section regenerates whenever team data changes. Don't edit by
          hand — changes will be overwritten.
        </p>
      )}
    </div>
  );
}
