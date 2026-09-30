import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, AlertCircle } from "lucide-react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { teamsApi } from "../../api/teams";
import { useCompany } from "../../context/CompanyContext";
import { useToast } from "../../context/ToastContext";

interface Props {
  teamId: string;
  initialManifest: Record<string, unknown>;
}

/**
 * YAML editor for a team's `manifest` JSONB column.
 *
 * Live-parses on each keystroke for inline error feedback. Save is disabled
 * when the YAML is invalid or the mutation is in flight. On success, broadly
 * invalidates `["teams", selectedCompanyId]` so any cached team detail (by-id
 * or by-slug), members, or coordination view re-fetches — Task 5.1's backend
 * cascades the manifest write into a coordination regen, so coordination
 * markdown can change as a side-effect of saving here.
 */
export function ManifestEditor({ teamId, initialManifest }: Props) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [yamlText, setYamlText] = useState(() => stringifyYaml(initialManifest));
  const [parseError, setParseError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const lastServerYamlRef = useRef(stringifyYaml(initialManifest));

  // Resync local state if the server-side initialManifest changes (e.g., after
  // a refetch from a sibling tab's mutation). Skip when the user has unsaved
  // edits — otherwise React Query's new object reference on refetch would
  // stomp the in-progress typing.
  useEffect(() => {
    const next = stringifyYaml(initialManifest);
    lastServerYamlRef.current = next;
    if (!isDirty) {
      setYamlText(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialManifest]);

  // Live-parse YAML for inline error feedback. Reject non-object shapes
  // (scalars, lists, null) explicitly so the backend isn't sent garbage.
  useEffect(() => {
    try {
      const parsed = parseYaml(yamlText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError(
          "Manifest must be a YAML object (mapping), not a list, scalar, or empty.",
        );
        return;
      }
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
    }
  }, [yamlText]);

  const saveMut = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try {
        parsed = parseYaml(yamlText);
      } catch (e) {
        throw new Error(`YAML parse error: ${(e as Error).message}`);
      }
      return teamsApi.updateManifest(teamId, parsed as Record<string, unknown>);
    },
    onSuccess: () => {
      pushToast({ title: "Manifest saved", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["teams", selectedCompanyId] });
      setIsDirty(false);
      // The next resync useEffect tick will overwrite yamlText with the
      // freshly-fetched value.
    },
    onError: (e) => {
      pushToast({
        title: "Save failed",
        body: (e as Error).message,
        tone: "error",
      });
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">manifest.yaml</h2>
          <p className="text-xs text-muted-foreground">
            Structured config — routing rules, member list, dependencies.
            Editing this regenerates auto sections in coordination.md.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending || parseError !== null}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          Save
        </Button>
      </div>

      {parseError && (
        <div
          id="manifest-yaml-error"
          role="alert"
          className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="text-destructive">{parseError}</span>
        </div>
      )}

      <Textarea
        value={yamlText}
        onChange={(e) => {
          setYamlText(e.target.value);
          setIsDirty(e.target.value !== lastServerYamlRef.current);
        }}
        rows={28}
        spellCheck={false}
        aria-label="Team manifest YAML editor"
        aria-invalid={parseError !== null}
        aria-describedby={parseError ? "manifest-yaml-error" : undefined}
        className="resize-y font-mono text-xs"
      />
    </div>
  );
}
