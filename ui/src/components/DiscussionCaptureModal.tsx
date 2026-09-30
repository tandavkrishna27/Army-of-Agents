import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { discussionsApi, type DiscussionListItem } from "../api/discussions";
import { projectsApi } from "../api/projects";
import { transcriptionApi } from "../api/transcription";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mic, MessageSquare } from "lucide-react";
import { VoiceRecorder } from "./VoiceRecorder";
import { cn } from "../lib/utils";

type TabValue = "paste" | "voice";

export function DiscussionCaptureModal() {
  const { discussionCaptureOpen, discussionCaptureDefaults, closeDiscussionCapture } = useDialog();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TabValue>("paste");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [scopeType, setScopeType] = useState(discussionCaptureDefaults.scopeType ?? "");
  const [scopeId, setScopeId] = useState(discussionCaptureDefaults.scopeId ?? "");
  const [departmentId, setDepartmentId] = useState(
    discussionCaptureDefaults.scopeType === "department" ? (discussionCaptureDefaults.scopeId ?? "") : "",
  );
  const [existingDiscussionId, setExistingDiscussionId] = useState("");
  const [discussionSearch, setDiscussionSearch] = useState("");

  // Voice state
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcription, setTranscription] = useState<string | null>(null);
  const [transcriptionEdited, setTranscriptionEdited] = useState("");
  const [lastRecordingBlob, setLastRecordingBlob] = useState<Blob | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [transcriptionRetries, setTranscriptionRetries] = useState(0);
  // 501 from /transcribe ⇒ voice not yet wired (Decision #91 / Commander sub-agent migration).
  const [voiceState, setVoiceState] = useState<
    { kind: "ok" } | { kind: "unavailable"; message: string }
  >({ kind: "ok" });
  const MAX_TRANSCRIPTION_RETRIES = 3;

  // Sync defaults when modal opens with pre-scoped values
  useEffect(() => {
    if (discussionCaptureOpen) {
      if (discussionCaptureDefaults.existingDiscussionId) {
        setExistingDiscussionId(discussionCaptureDefaults.existingDiscussionId);
      }
      if (discussionCaptureDefaults.scopeType) {
        setScopeType(discussionCaptureDefaults.scopeType);
        setScopeId(discussionCaptureDefaults.scopeId ?? "");
        if (discussionCaptureDefaults.scopeType === "department") {
          setDepartmentId(discussionCaptureDefaults.scopeId ?? "");
        }
      }
    }
  }, [discussionCaptureOpen, discussionCaptureDefaults]);

  // Fetch departments for scope dropdown
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && discussionCaptureOpen,
  });
  const departments = projects?.filter((p) => p.type === "department") ?? [];

  // Fetch recent discussions for "Add to existing" dropdown
  const { data: recentDiscussions } = useQuery({
    queryKey: queryKeys.discussions.list(selectedCompanyId!),
    queryFn: () =>
      discussionsApi.list(selectedCompanyId!, { status: "active", limit: 20, sortBy: "lastEntryAt", sortOrder: "desc" }),
    enabled: !!selectedCompanyId && discussionCaptureOpen,
  });

  const filteredDiscussions = (recentDiscussions?.discussions ?? []).filter(
    (d) =>
      !discussionSearch ||
      d.title.toLowerCase().includes(discussionSearch.toLowerCase()),
  );

  // Create new discussion mutation
  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      discussionsApi.create(selectedCompanyId!, data as any),
    onSuccess: (discussion) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discussions.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["threads", selectedCompanyId!] });
      resetAndClose();
      pushToast({
        title: "Discussion created",
        body: "Click Reprocess to extract items from your content.",
        tone: "success",
      });
      navigate(`/discussions/${discussion.id}`);
    },
    onError: () => {
      pushToast({ title: "Failed to create discussion", tone: "warn" });
    },
  });

  // Add entry to existing discussion mutation
  const addEntryMutation = useMutation({
    mutationFn: (data: { discussionId: string; entry: Record<string, unknown> }) =>
      discussionsApi.addEntry(selectedCompanyId!, data.discussionId, data.entry as any),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discussions.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["threads", selectedCompanyId!] });
      queryClient.invalidateQueries({
        queryKey: queryKeys.discussions.detail(selectedCompanyId!, vars.discussionId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.threads.detail(selectedCompanyId!, vars.discussionId),
      });
      resetAndClose();
      pushToast({
        title: "Entry added",
        body: "Click Reprocess to extract items from your content.",
        tone: "success",
      });
      navigate(`/discussions/${vars.discussionId}`);
    },
    onError: () => {
      pushToast({ title: "Failed to add entry", tone: "warn" });
    },
  });

  function resetAndClose() {
    setTab("paste");
    setContent("");
    setTitle("");
    setScopeType("");
    setScopeId("");
    setDepartmentId("");
    setExistingDiscussionId("");
    setDiscussionSearch("");
    setIsTranscribing(false);
    setTranscription(null);
    setTranscriptionEdited("");
    setLastRecordingBlob(null);
    setTranscriptionError(null);
    setTranscriptionRetries(0);
    setVoiceState({ kind: "ok" });
    closeDiscussionCapture();
  }

  function handleSubmit() {
    if (!selectedCompanyId) return;

    const rawContent =
      tab === "voice"
        ? (transcriptionEdited.trim() || transcription?.trim() || "")
        : content.trim();

    if (!rawContent) return;

    const entryPayload: Record<string, unknown> = {
      inputType: tab,
      rawContent,
      ...(departmentId ? { departmentId } : {}),
    };

    if (existingDiscussionId) {
      // Add to existing discussion
      addEntryMutation.mutate({
        discussionId: existingDiscussionId,
        entry: entryPayload,
      });
    } else {
      // Create new discussion — use explicit scope from defaults, or department dropdown
      const resolvedScope = scopeType && scopeId
        ? { scopeType, scopeId }
        : departmentId
          ? { scopeType: "department", scopeId: departmentId }
          : {};
      createMutation.mutate({
        ...(title.trim() ? { title: title.trim() } : {}),
        ...resolvedScope,
        entry: entryPayload,
      });
    }
  }

  async function handleRecordingComplete(blob: Blob, isRetry = false) {
    if (!isRetry) {
      setLastRecordingBlob(blob);
      setTranscriptionRetries(0);
    }
    setTranscriptionError(null);

    if (!selectedCompanyId) return;

    setIsTranscribing(true);
    try {
      const result = await transcriptionApi.transcribe(selectedCompanyId, blob);
      setTranscription(result.text);
      setTranscriptionEdited(result.text);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 501) {
        setVoiceState({
          kind: "unavailable",
          message:
            "Voice input is not yet available in this build. Please use Paste or Write for now.",
        });
        setTranscription(null);
      } else {
        const message = err instanceof Error ? err.message : "Transcription failed";
        setTranscriptionError(message);
        setTranscription(null);
      }
    } finally {
      setIsTranscribing(false);
    }
  }

  async function retryTranscription() {
    if (!lastRecordingBlob || transcriptionRetries >= MAX_TRANSCRIPTION_RETRIES) return;
    setTranscriptionRetries((r) => r + 1);
    await handleRecordingComplete(lastRecordingBlob, true);
  }

  const isSubmitting = createMutation.isPending || addEntryMutation.isPending;

  const voiceContent = transcriptionEdited.trim() || transcription?.trim();
  const canSubmit =
    tab === "voice"
      ? !!voiceContent && !isTranscribing
      : !!content.trim();

  return (
    <Dialog open={discussionCaptureOpen} onOpenChange={(open) => { if (!open) resetAndClose(); }}>
      <DialogContent
        showCloseButton={!isSubmitting}
        className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto flex flex-col"
      >
        <DialogHeader>
          <DialogTitle>
            {existingDiscussionId ? "Add to Discussion" : "New Discussion"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {existingDiscussionId ? "Add a new entry to this discussion" : "Start a new discussion thread"}
          </DialogDescription>
        </DialogHeader>

        {isSubmitting ? (
          <DialogBody className="flex flex-col items-center justify-center gap-3 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Submitting...</p>
            <p className="text-xs text-muted-foreground/60">
              Content will be processed asynchronously
            </p>
          </DialogBody>
        ) : (
          <DialogBody className="flex flex-col gap-4">
            {/* Add to existing discussion */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="discussion-existing" className="text-xs text-muted-foreground">
                Add to existing discussion (optional)
              </Label>
              <select
                id="discussion-existing"
                value={existingDiscussionId}
                onChange={(e) => setExistingDiscussionId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">New standalone discussion</option>
                {filteredDiscussions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                    {d.pendingItemCount > 0 ? ` (${d.pendingItemCount} pending)` : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Input tabs */}
            <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
              <TabsList>
                <TabsTrigger value="paste">Paste / Write</TabsTrigger>
                <TabsTrigger value="voice" className="gap-1.5">
                  <Mic className="h-3.5 w-3.5" />
                  Voice
                </TabsTrigger>
              </TabsList>
              <TabsContent value="paste" className="mt-3">
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Paste meeting notes, transcripts, or write your observations..."
                  className="min-h-[200px] max-h-[300px] resize-y"
                />
              </TabsContent>
              <TabsContent value="voice" className="mt-3">
                <div className="flex flex-col gap-3">
                  {voiceState.kind === "unavailable" && (
                    <div
                      role="alert"
                      className="rounded-md border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      {voiceState.message}
                    </div>
                  )}
                  <VoiceRecorder
                    onRecordingComplete={handleRecordingComplete}
                    disabled={isTranscribing || voiceState.kind === "unavailable"}
                  />
                  {isTranscribing && (
                    <div className="flex items-center gap-2 rounded-md bg-muted/50 p-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">Transcribing audio...</span>
                    </div>
                  )}
                  {transcription !== null && !isTranscribing && (
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">
                        Transcription (edit if needed)
                      </Label>
                      <Textarea
                        value={transcriptionEdited}
                        onChange={(e) => setTranscriptionEdited(e.target.value)}
                        className="min-h-[120px] resize-y"
                      />
                    </div>
                  )}
                  {transcriptionError && !isTranscribing && (
                    <div className="flex items-center gap-2 text-sm text-destructive">
                      <span>{transcriptionError}</span>
                      {transcriptionRetries < MAX_TRANSCRIPTION_RETRIES && (
                        <Button variant="outline" size="sm" onClick={retryTranscription}>
                          Retry ({MAX_TRANSCRIPTION_RETRIES - transcriptionRetries} left)
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>

            {/* Title and department fields (only for new discussion) */}
            {!existingDiscussionId && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="discussion-title" className="text-xs text-muted-foreground">
                    Title (optional — auto-generated if empty)
                  </Label>
                  <Input
                    id="discussion-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Q1 Planning Session Notes"
                  />
                </div>

                {/* Hide department selector when pre-scoped to a non-department entity */}
                {!scopeType || scopeType === "department" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="discussion-dept" className="text-xs text-muted-foreground">
                      Department (optional)
                    </Label>
                    <select
                      id="discussion-dept"
                      value={departmentId}
                      onChange={(e) => {
                        setDepartmentId(e.target.value);
                        if (!scopeType) {
                          // Only update scope if not pre-scoped
                          setScopeType(e.target.value ? "department" : "");
                          setScopeId(e.target.value);
                        }
                      }}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="">No department</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit || !selectedCompanyId}
              >
                <MessageSquare className="h-4 w-4 mr-1.5" />
                {existingDiscussionId ? "Add Entry" : "Start Discussion"}
              </Button>
            </div>
          </DialogBody>
        )}
      </DialogContent>
    </Dialog>
  );
}
