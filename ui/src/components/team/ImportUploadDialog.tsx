import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { teamsApi, type TeamImportPreview } from "../../api/teams";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { ImportPreviewDialog } from "./ImportPreviewDialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Slice 8 / Task 8.4: First step of the import flow. Founder/team_lead
 * picks the parent department FIRST (Task 4 / P1-A: server-side dept
 * gate must receive `parentProjectId` on preview so a team_lead can't
 * probe agent collisions in another dept by uploading any manifest),
 * then picks a `.team.yaml` file (drag/drop or browse). On success we
 * hand off to `ImportPreviewDialog`, which renders the diff + collision
 * resolver and triggers the actual install. We hold onto the raw YAML
 * so the install call can replay it server-side without a second upload.
 */
export function ImportUploadDialog({ open, onOpenChange }: Props) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const [parentProjectId, setParentProjectId] = useState("");
  const [yamlContent, setYamlContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<TeamImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Department list for the parent picker. Manifests are intentionally
  // dept-agnostic, so the user picks where the imported team lives. The
  // server-side dept gate (assertDepartmentAccess) refuses uploads for
  // depts the team_lead doesn't own, so non-founders can only see depts
  // they have access to in this list — but the server is the source of
  // truth either way.
  const projectsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.projects.list(selectedCompanyId)
      : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const departments = (projectsQuery.data ?? []).filter(
    (p) => p.type === "department",
  );

  async function handleFile(file: File) {
    if (!selectedCompanyId) return;
    if (!parentProjectId) {
      pushToast({
        title: "Pick a department first",
        body: "Choose where this team should live before uploading.",
        tone: "error",
      });
      return;
    }
    setLoading(true);
    try {
      // Read the YAML once on the client so we can both submit it for
      // preview AND replay it on install — no second upload required.
      const text = await file.text();
      setYamlContent(text);
      const result = await teamsApi.previewImport(
        selectedCompanyId,
        file,
        parentProjectId,
      );
      setPreview(result);
    } catch (err) {
      pushToast({
        title: "Import failed",
        body: (err as Error).message,
        tone: "error",
      });
      setYamlContent(null);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  function handleDialogChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Drop preview state when the dialog closes so the next open
      // starts at the upload step.
      setParentProjectId("");
      setYamlContent(null);
      setPreview(null);
      setLoading(false);
    }
  }

  // Once the preview is loaded, swap in the preview dialog. Closing the
  // preview dialog flows back through `handleDialogChange` and resets us.
  if (preview && yamlContent) {
    return (
      <ImportPreviewDialog
        open={open}
        onOpenChange={handleDialogChange}
        preview={preview}
        yamlContent={yamlContent}
        parentProjectId={parentProjectId}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import team from file</DialogTitle>
          <DialogDescription>Upload a .team.yaml package.</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* Parent dept picker — required before upload */}
          <div className="rounded-md bg-amber-50 p-3 dark:bg-amber-950/20">
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="text-base">
                📁
              </span>
              <div className="flex-1">
                <p className="text-xs font-bold">Pick a parent department</p>
                <p className="text-[11px] text-muted-foreground">
                  Templates don't include a department — choose where this team
                  lives.
                </p>
              </div>
              <Select
                value={parentProjectId}
                onValueChange={setParentProjectId}
              >
                <SelectTrigger className="h-8 w-[180px] text-xs">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div
            className={`rounded-lg border-2 border-dashed border-muted-foreground/30 p-9 text-center ${
              !parentProjectId ? "opacity-50 pointer-events-none" : ""
            }`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void handleFile(f);
            }}
          >
            <Upload
              className="mx-auto h-8 w-8 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="mt-2 text-sm font-bold">Drag a team file here</p>
            <p className="text-xs text-muted-foreground">or</p>
            <Button
              onClick={() => fileRef.current?.click()}
              className="mt-3"
              disabled={loading || !parentProjectId}
            >
              {loading ? "Parsing…" : "Browse files"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".yaml,.yml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <p className="mt-3 text-[10px] text-muted-foreground">
              .yaml · .yml · max 5MB
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            The file is parsed and you'll get a preview before anything is
            written.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
