import { useEffect, useState } from "react";
import { Clock3, Plus, Webhook, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type TriggerKind = "schedule" | "webhook";
type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "specific_days" | "custom";
type SigningMode = "bearer" | "hmac_sha256";

const SCHEDULE_PRESETS: { value: SchedulePreset; label: string; desc: string }[] = [
  { value: "every_minute",  label: "Every minute",   desc: "* * * * *"   },
  { value: "every_hour",    label: "Every hour",     desc: "Repeating"   },
  { value: "every_day",     label: "Every day",      desc: "Once daily"  },
  { value: "weekdays",      label: "Weekdays",       desc: "Mon – Fri"   },
  { value: "specific_days", label: "Specific days",  desc: "Pick days"   },
  { value: "custom",        label: "Custom cron",    desc: "Advanced"    },
];

const DAYS = [
  { value: "1", short: "M", full: "Mon" },
  { value: "2", short: "T", full: "Tue" },
  { value: "3", short: "W", full: "Wed" },
  { value: "4", short: "T", full: "Thu" },
  { value: "5", short: "F", full: "Fri" },
  { value: "6", short: "S", full: "Sat" },
  { value: "0", short: "S", full: "Sun" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: i === 0 ? "12 AM" : i < 12 ? `${i} AM` : i === 12 ? "12 PM" : `${i - 12} PM`,
}));

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

const REPLAY_PRESETS = [
  { value: "60",  label: "1 min"  },
  { value: "300", label: "5 min"  },
  { value: "900", label: "15 min" },
];

function parseCronToDialogState(cron: string): { preset: SchedulePreset; hour: string; minute: string; days: string[] } {
  const defaults = { hour: "10", minute: "0", days: ["1"] as string[] };
  if (!cron?.trim()) return { preset: "every_day", ...defaults };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { preset: "custom", ...defaults };
  const [min, hr, dom, , dow] = parts;
  if (min === "*" && hr === "*" && dom === "*" && dow === "*") return { preset: "every_minute", ...defaults };
  if (hr === "*" && dom === "*" && dow === "*") return { preset: "every_hour", ...defaults, minute: min === "*" ? "0" : min };
  if (dom === "*" && dow === "*" && hr !== "*") return { preset: "every_day", hour: hr, minute: min === "*" ? "0" : min, days: ["1"] };
  if (dom === "*" && dow === "1-5" && hr !== "*") return { preset: "weekdays", hour: hr, minute: min === "*" ? "0" : min, days: ["1","2","3","4","5"] };
  if (dom === "*" && hr !== "*" && dow !== "*" && dow !== "1-5") {
    const days = dow.split(",").map((d) => d.trim()).filter((d) => /^\d$/.test(d));
    if (days.length > 0) return { preset: "specific_days", hour: hr, minute: min === "*" ? "0" : min, days };
  }
  return { preset: "custom", ...defaults };
}

function buildCron(preset: SchedulePreset, hour: string, minute: string, days: string[]): string {
  const sortedDays = [...days].sort((a, b) => Number(a) - Number(b)).join(",");
  switch (preset) {
    case "every_minute":  return "* * * * *";
    case "every_hour":    return `${minute} * * * *`;
    case "every_day":     return `${minute} ${hour} * * *`;
    case "weekdays":      return `${minute} ${hour} * * 1-5`;
    case "specific_days": return days.length > 0 ? `${minute} ${hour} * * ${sortedDays}` : "";
    default:              return "";
  }
}

function describeScheduleLocal(preset: SchedulePreset, hour: string, minute: string, days: string[]): string {
  const h = HOURS.find((x) => x.value === hour)?.label ?? `${hour}`;
  const hBase = h.replace(/ (AM|PM)$/, "");
  const ampm = h.match(/(AM|PM)$/)?.[0] ?? "";
  const time = `${hBase}:${minute.padStart(2, "0")} ${ampm}`.trim();

  switch (preset) {
    case "every_minute":  return "Every minute";
    case "every_hour":    return `Every hour at :${minute.padStart(2, "0")}`;
    case "every_day":     return `Every day at ${time}`;
    case "weekdays":      return `Weekdays at ${time}`;
    case "specific_days": {
      if (days.length === 0) return "Pick at least one day";
      const names = days
        .slice()
        .sort((a, b) => Number(a) - Number(b))
        .map((v) => DAYS.find((d) => d.value === v)?.full ?? v);
      return `Every ${names.join(", ")} at ${time}`;
    }
    default: return "Configure above";
  }
}

interface QueuedSchedule {
  id: string;
  cronExpression: string;
  description: string;
}

export interface NewTriggerConfig {
  kind: TriggerKind;
  cronExpression?: string;
  signingMode?: SigningMode;
  replayWindowSec?: number;
  label?: string;
}

interface AddTriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  defaultKind?: "schedule" | "webhook";
  // Create mode
  onAdd?: (triggers: NewTriggerConfig[]) => void;
  // Edit mode — when set, onAdd is unused
  editMode?: boolean;
  initialConfig?: NewTriggerConfig;
  onSave?: (config: NewTriggerConfig) => void;
}

export function AddTriggerDialog({
  open,
  onOpenChange,
  onAdd,
  isPending,
  defaultKind = "schedule",
  editMode,
  initialConfig,
  onSave,
}: AddTriggerDialogProps) {
  const [kind, setKind] = useState<TriggerKind>(defaultKind);

  // schedule state
  const [preset, setPreset] = useState<SchedulePreset>("every_day");
  const [hour, setHour] = useState("10");
  const [minute, setMinute] = useState("0");
  const [selectedDays, setSelectedDays] = useState<string[]>(["1"]); // default Mon
  const [customCron, setCustomCron] = useState("0 10 * * *");
  const [queue, setQueue] = useState<QueuedSchedule[]>([]);

  // webhook state
  const [signingMode, setSigningMode] = useState<SigningMode>("bearer");
  const [replayWindow, setReplayWindow] = useState("300");
  const [webhookLabel, setWebhookLabel] = useState("");

  useEffect(() => {
    if (!open || !editMode || !initialConfig) return;
    setKind(initialConfig.kind);
    if (initialConfig.kind === "schedule") {
      const parsed = parseCronToDialogState(initialConfig.cronExpression ?? "");
      setPreset(parsed.preset);
      setHour(parsed.hour);
      setMinute(parsed.minute);
      setSelectedDays(parsed.days);
      setCustomCron(parsed.preset === "custom" ? (initialConfig.cronExpression ?? "") : "0 10 * * *");
    } else {
      setSigningMode(initialConfig.signingMode ?? "bearer");
      setReplayWindow(String(initialConfig.replayWindowSec ?? 300));
      setWebhookLabel(initialConfig.label ?? "");
    }
  }, [open, editMode, initialConfig]);

  const currentCron = preset === "custom"
    ? customCron
    : buildCron(preset, hour, minute, selectedDays);

  const currentDescription = preset === "custom"
    ? (customCron || "Configure above")
    : describeScheduleLocal(preset, hour, minute, selectedDays);

  const toggleDay = (value: string) => {
    setSelectedDays((prev) =>
      prev.includes(value)
        ? prev.length > 1 ? prev.filter((d) => d !== value) : prev // keep at least one
        : [...prev, value],
    );
  };

  const handleQueueSchedule = () => {
    if (!currentCron) return;
    setQueue((q) => [
      ...q,
      { id: Math.random().toString(36).slice(2), cronExpression: currentCron, description: currentDescription },
    ]);
  };

  const handleConfirm = () => {
    if (editMode && onSave) {
      if (kind === "schedule") {
        onSave({ kind: "schedule", cronExpression: currentCron });
      } else {
        onSave({ kind: "webhook", signingMode, replayWindowSec: Number(replayWindow), label: webhookLabel || undefined });
      }
      return;
    }
    if (kind === "schedule") {
      const all = queue.length > 0
        ? queue
        : [{ id: "0", cronExpression: currentCron, description: currentDescription }];
      onAdd?.(all.map((q) => ({ kind: "schedule" as const, cronExpression: q.cronExpression })));
    } else {
      onAdd?.([{ kind: "webhook", signingMode, replayWindowSec: Number(replayWindow), label: webhookLabel || undefined }]);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setKind(defaultKind);
      setPreset("every_day");
      setHour("10");
      setMinute("0");
      setSelectedDays(["1"]);
      setCustomCron("0 10 * * *");
      setQueue([]);
      setSigningMode("bearer");
      setReplayWindow("300");
      setWebhookLabel("");
    }
    onOpenChange(next);
  };

  const canConfirm = kind === "schedule"
    ? (queue.length > 0 || !!currentCron)
    : true;

  const showTimeRow = preset !== "custom" && preset !== "every_minute";
  const showDayPills = preset === "specific_days";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[480px] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle>
            {editMode ? `Edit ${kind} trigger` : "Add trigger"}
          </DialogTitle>
        </DialogHeader>

        {/* Type tabs — hidden in edit mode */}
        {!editMode && <div className="flex gap-2 px-5 pt-4">
          {([
            { value: "schedule" as const, label: "Schedule", icon: Clock3, activeClass: "border-blue-500 bg-blue-500/10 text-blue-400" },
            { value: "webhook"  as const, label: "Webhook",  icon: Webhook, activeClass: "border-purple-500 bg-purple-500/10 text-purple-400" },
          ] as const).map(({ value, label, icon: Icon, activeClass }) => (
            <button
              key={value}
              type="button"
              onClick={() => setKind(value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                kind === value
                  ? activeClass
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>}

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {kind === "schedule" ? (
            <>
              {/* Preset grid */}
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Frequency</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {SCHEDULE_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setPreset(p.value)}
                      className={cn(
                        "flex flex-col items-start rounded-lg border px-3 py-2.5 text-left text-xs font-medium transition-colors",
                        preset === p.value
                          ? "border-blue-500 bg-blue-500/10 text-blue-400"
                          : "border-border bg-card text-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {p.label}
                      <span className={cn("mt-0.5 font-normal", preset === p.value ? "text-blue-400/60" : "text-muted-foreground/60")}>
                        {p.desc}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Day pills — only for specific_days */}
              {showDayPills && (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Days</p>
                  <div className="flex gap-1.5">
                    {DAYS.map((d) => {
                      const active = selectedDays.includes(d.value);
                      return (
                        <button
                          key={d.value}
                          type="button"
                          onClick={() => toggleDay(d.value)}
                          title={d.full}
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-semibold transition-colors",
                            active
                              ? "border-blue-500 bg-blue-500/15 text-blue-400"
                              : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          {d.short}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Time row */}
              {showTimeRow && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-accent/30 px-3 py-2.5">
                  <span className="text-xs text-muted-foreground">at</span>
                  {preset !== "every_hour" && (
                    <Select value={hour} onValueChange={setHour}>
                      <SelectTrigger className="h-7 w-[90px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HOURS.map((h) => (
                          <SelectItem key={h.value} value={h.value} className="text-xs">{h.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <span className="text-xs text-muted-foreground">:</span>
                  <Select value={minute} onValueChange={setMinute}>
                    <SelectTrigger className="h-7 w-[68px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MINUTES.map((m) => (
                        <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="ml-auto text-[11px] text-blue-400/80">{currentDescription}</span>
                </div>
              )}

              {/* Every minute — just show the description */}
              {preset === "every_minute" && (
                <div className="flex items-center rounded-lg border border-border bg-accent/30 px-3 py-2.5">
                  <span className="text-[11px] text-blue-400/80">{currentDescription}</span>
                </div>
              )}

              {/* Custom cron */}
              {preset === "custom" && (
                <div className="space-y-1.5">
                  <Input
                    value={customCron}
                    onChange={(e) => setCustomCron(e.target.value)}
                    placeholder="0 10 * * *"
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">minute · hour · day-of-month · month · day-of-week</p>
                </div>
              )}

              {/* Queued list */}
              {!editMode && queue.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Added ({queue.length})
                  </p>
                  <div className="space-y-1">
                    {queue.map((q) => (
                      <div key={q.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                          {q.description}
                        </div>
                        <button
                          type="button"
                          onClick={() => setQueue((prev) => prev.filter((x) => x.id !== q.id))}
                          className="text-muted-foreground/50 hover:text-destructive transition-colors"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Queue button — hidden in edit mode */}
              {!editMode && <button
                type="button"
                disabled={!currentCron}
                onClick={handleQueueSchedule}
                className={cn(
                  "flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs font-medium transition-colors",
                  currentCron
                    ? "border-blue-500/40 text-blue-400 hover:border-blue-500 hover:bg-blue-500/5"
                    : "border-border text-muted-foreground/40 cursor-not-allowed",
                )}
              >
                <Plus className="h-3.5 w-3.5" />
                Add another schedule
              </button>}
            </>
          ) : (
            <>
              {/* Signing mode */}
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Signing mode</Label>
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    { value: "bearer"      as const, label: "Bearer token",  desc: "Simple, header-based" },
                    { value: "hmac_sha256" as const, label: "HMAC SHA-256",  desc: "Signed payload"       },
                  ] as const).map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setSigningMode(m.value)}
                      className={cn(
                        "flex flex-col items-start rounded-lg border px-3 py-2.5 text-left text-xs font-medium transition-colors",
                        signingMode === m.value
                          ? "border-purple-500 bg-purple-500/10 text-purple-400"
                          : "border-border bg-card text-foreground hover:bg-accent",
                      )}
                    >
                      {m.label}
                      <span className={cn("mt-0.5 font-normal", signingMode === m.value ? "text-purple-400/60" : "text-muted-foreground/60")}>
                        {m.desc}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Replay window */}
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Replay window</Label>
                <div className="flex gap-1.5">
                  {REPLAY_PRESETS.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => setReplayWindow(r.value)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                        replayWindow === r.value
                          ? "border-purple-500 bg-purple-500/10 text-purple-400"
                          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                  <input
                    type="number"
                    min={1}
                    value={REPLAY_PRESETS.some((r) => r.value === replayWindow) ? "" : replayWindow}
                    onChange={(e) => setReplayWindow(e.target.value)}
                    placeholder="Custom s"
                    className="h-[30px] w-[84px] rounded-md border border-border bg-card px-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-purple-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Label */}
              <div className="space-y-2">
                <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Label <span className="normal-case font-normal">(optional)</span>
                </Label>
                <Input
                  value={webhookLabel}
                  onChange={(e) => setWebhookLabel(e.target.value)}
                  placeholder="e.g. github-push"
                  className="text-sm"
                />
              </div>

              <p className="rounded-lg border border-border bg-accent/30 px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
                A unique URL and secret will be generated after saving. Copy them immediately — the secret is shown only once.
              </p>
            </>
          )}
        </div>

        <DialogFooter className="rounded-b-2xl">
          <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={isPending || !canConfirm}>
            {editMode
              ? "Save changes"
              : isPending
                ? "Adding..."
                : kind === "schedule"
                  ? `Add ${queue.length > 1 ? `${queue.length} schedules` : "trigger"}`
                  : "Create webhook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
