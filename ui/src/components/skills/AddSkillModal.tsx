// ui/src/components/skills/AddSkillModal.tsx
import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { CompanySkillCreateRequest } from "@armyofagents/shared";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (source: string) => void;
  importPending: boolean;
  onCreate: (payload: CompanySkillCreateRequest) => void;
  createPending: boolean;
}

export function AddSkillModal({
  open,
  onOpenChange,
  onImport,
  importPending,
  onCreate,
  createPending,
}: Props) {
  const [tab, setTab] = useState<"import" | "create">("import");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  function resetForm() {
    setSource("");
    setName("");
    setSlug("");
    setDescription("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex flex-col sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add Skill</DialogTitle>
          <DialogDescription>Import from a source or create a custom skill.</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "import" | "create")}>
            <TabsList>
              <TabsTrigger value="import">Import</TabsTrigger>
              <TabsTrigger value="create">Create</TabsTrigger>
            </TabsList>

            <TabsContent value="import" className="mt-3">
              <div className="space-y-3">
                <Input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Paste GitHub URL, skills.sh command, or local path"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && source.trim()) onImport(source.trim());
                  }}
                />
                <p className="text-xs text-dim">
                  e.g. <code className="text-[11px]">https://github.com/owner/repo</code> or{" "}
                  <code className="text-[11px]">npx skills add owner/repo/skill</code>
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex gap-3">
                    <a
                      href="https://skills.sh"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-dim transition-colors hover:text-text"
                    >
                      Browse skills.sh <ExternalLink className="h-3 w-3" />
                    </a>
                    <a
                      href="https://github.com/search?q=SKILL.md&type=code"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-dim transition-colors hover:text-text"
                    >
                      Search GitHub <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => onImport(source.trim())}
                    disabled={importPending || source.trim().length === 0}
                  >
                    {importPending ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    {importPending ? "Importing..." : "Import"}
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="create" className="mt-3">
              <div className="space-y-3">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Skill name"
                />
                <Input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="optional-shortname"
                />
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description"
                  className="min-h-20 resize-y"
                />
                <div className="flex items-center justify-end">
                  <Button
                    size="sm"
                    onClick={() =>
                      onCreate({ name, slug: slug || null, description: description || null })
                    }
                    disabled={createPending || name.trim().length === 0}
                  >
                    {createPending ? "Creating..." : "Create skill"}
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
