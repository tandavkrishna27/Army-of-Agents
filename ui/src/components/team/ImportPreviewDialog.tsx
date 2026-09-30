import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { teamsApi, type TeamImportPreview } from "../../api/teams";
import { useCompany } from "../../context/CompanyContext";
import { useToast } from "../../context/ToastContext";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "../../lib/queryKeys";

type CollisionAction = "rename" | "replace" | "skip";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: TeamImportPreview;
  yamlContent: string;
  /**
   * Task 4 (P1-A): the parent department is now picked in the upload
   * dialog (before preview) so the server-side dept gate can fire on
   * the preview request itself. Passed through here for the install
   * mutation.
   */
  parentProjectId: string;
}

/**
 * Slice 8 / Task 8.4: Renders the import diff (member list with
 * collision badges + per-row resolver, missing-skill warning) and
 * triggers the install on confirmation. The Install button is disabled
 * client-side when `skillsToInstall` is non-empty because the server will
 * refuse the cascade in that case (Task 8.2 / `team-import.ts`); better UX
 * to short-circuit than to surface a generic 500.
 *
 * Task 4 (P1-A): parent-department picker moved to the upload dialog so
 * the server-side dept gate can validate access before disclosing
 * cross-dept agent collision data via preview.
 */
export function ImportPreviewDialog({
  open,
  onOpenChange,
  preview,
  yamlContent,
  parentProjectId,
}: Props) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [collisions, setCollisions] = useState<
    Record<string, CollisionAction>
  >({});

  const installMut = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("no company selected");
      return teamsApi.installImport(selectedCompanyId, {
        yamlContent,
        collisions,
        parentProjectId,
      });
    },
    onSuccess: (team) => {
      pushToast({
        title: "Team installed",
        body: team.name,
        tone: "success",
      });
      // Task 11 / P3-D: surface non-fatal install side effects (e.g.
      // 'replace' silently granting dept membership) as separate
      // warning toasts. Server always returns an array (possibly
      // empty), so a length check is sufficient.
      if (team.warnings && team.warnings.length > 0) {
        for (const warning of team.warnings) {
          pushToast({
            title: "Import warning",
            body: warning,
            tone: "warn",
            // Lift the warn TTL above the default so the founder has
            // time to read the dept-grant message before it
            // disappears -- the default warn TTL (8s) clamps within
            // the toast context's MIN/MAX bounds.
            ttlMs: 12000,
          });
        }
      }
      // C3 (comprehensive-review fixup): import installs may create new
      // agents (rename / no-collision branches) and grants dept membership
      // (replace branch). Match BuildFromScratchForm's invalidation set so
      // the dept-detail page and agents list refetch after install.
      queryClient.invalidateQueries({
        queryKey: queryKeys.teams.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.agents(parentProjectId),
      });
      onOpenChange(false);
      navigate(`/team/teams/${team.slug}`);
    },
    onError: (err) => {
      pushToast({
        title: "Install failed",
        body: (err as Error).message,
        tone: "error",
      });
    },
  });

  const allCollisionsResolved = preview.collisions.every(
    (c) => collisions[c.name],
  );
  const canInstall =
    Boolean(parentProjectId) && allCollisionsResolved && !installMut.isPending;

  const skipCount = Object.values(collisions).filter((v) => v === "skip").length;
  const willCreate = preview.manifest.agents.length - skipCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {preview.manifest.displayName ?? preview.manifest.name}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            v{preview.manifest.version}
          </p>
        </DialogHeader>

        <DialogBody>
        {/* Members */}
        <section className="mt-3">
          <h3 className="mb-2 text-xs font-bold">
            Members ({preview.manifest.agents.length})
          </h3>
          {preview.manifest.agents.map((a) => {
            const wantedName = "name" in a ? a.name : a.localName;
            const collision = preview.collisions.find(
              (c) => c.name === wantedName,
            );
            return (
              <div
                key={wantedName}
                className={`mb-1.5 rounded-md p-2.5 ${
                  collision
                    ? "bg-red-50 dark:bg-red-950/20 border border-red-300"
                    : "bg-green-50 dark:bg-green-950/20"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold">{wantedName}</span>
                  {collision ? (
                    <Badge className="bg-red-100 text-red-800 text-[9px]">
                      ⚠ COLLISION
                    </Badge>
                  ) : (
                    <Badge className="bg-green-100 text-green-800 text-[9px]">
                      WILL CREATE
                    </Badge>
                  )}
                  {collision && (
                    <Select
                      value={collisions[wantedName] ?? ""}
                      onValueChange={(v) =>
                        setCollisions({
                          ...collisions,
                          [wantedName]: v as CollisionAction,
                        })
                      }
                    >
                      <SelectTrigger className="h-6 w-[100px] text-xs ml-auto">
                        <SelectValue placeholder="Resolve" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rename">Rename</SelectItem>
                        <SelectItem value="replace">Replace</SelectItem>
                        <SelectItem value="skip">Skip</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* Skills (will fetch — v1: must be pre-installed) */}
        {preview.skillsToInstall.length > 0 && (
          <section className="mt-3">
            <h3 className="mb-2 text-xs font-bold">
              Required skills (not installed)
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {preview.skillsToInstall.map((s) => (
                <Badge
                  key={s}
                  className="bg-amber-100 text-amber-800 text-[10px]"
                >
                  ⬇ {s}
                </Badge>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-amber-800">
              These skills must be installed first. Install will fail until
              they are present.
            </p>
          </section>
        )}
        </DialogBody>

        <DialogFooter className="border-t pt-3">
          <span className="mr-auto text-[11px] text-muted-foreground">
            Will create {willCreate} agents · {preview.skillsToInstall.length}{" "}
            missing skills · resolve {preview.collisions.length} collisions
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canInstall || preview.skillsToInstall.length > 0}
            onClick={() => installMut.mutate()}
          >
            {installMut.isPending ? "Installing…" : "Install team →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
