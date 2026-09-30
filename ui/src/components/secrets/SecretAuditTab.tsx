import { useState } from "react";
import { Activity, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { SecretAccessEvent } from "@armyofagents/shared";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatSecretDate, providerLabel } from "./secret-ui";

interface SecretAuditTabProps {
  events: SecretAccessEvent[];
  errorMessage?: string | null;
}

function outcomeClassName(outcome: SecretAccessEvent["outcome"]) {
  if (outcome === "success") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  return "border-destructive/35 bg-destructive/10 text-destructive";
}

function valueOrDash(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function DetailRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-mono text-xs">{valueOrDash(value)}</dd>
    </div>
  );
}

export function SecretAuditTab({ events, errorMessage }: SecretAuditTabProps) {
  const [selectedEvent, setSelectedEvent] = useState<SecretAccessEvent | null>(null);

  return (
    <>
      {errorMessage ? (
        <section className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <p>Failed to load audit events for this secret.</p>
          <p className="mt-1 text-xs text-destructive/80">{errorMessage}</p>
        </section>
      ) : events.length === 0 ? (
        <section className="flex min-h-[280px] flex-col items-center justify-center rounded-md border border-border bg-card px-6 py-10 text-center">
          <Activity className="mb-3 size-8 text-muted-foreground/40" />
          <h3 className="text-sm font-semibold">No access events</h3>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Runtime reads and failures for the selected secret will appear here.
          </p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-md border border-border bg-card">
          <div className="divide-y divide-border">
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                className="block w-full px-4 py-3 text-left transition-colors hover:bg-accent/50"
                onClick={() => setSelectedEvent(event)}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      {event.outcome === "success" ? (
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                      ) : (
                        <AlertTriangle className="size-4 shrink-0 text-destructive" />
                      )}
                      <span className="truncate text-sm font-semibold">
                        {event.consumerType}:{event.consumerId}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {event.actorType}:{event.actorId ?? "system"} - {event.configPath ?? "direct"} -{" "}
                      {formatSecretDate(event.createdAt)}
                    </div>
                  </div>
                  <Badge variant="outline" className={cn("capitalize", outcomeClassName(event.outcome))}>
                    {event.outcome}
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <Dialog open={Boolean(selectedEvent)} onOpenChange={(open) => !open && setSelectedEvent(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Audit event</DialogTitle>
            <DialogDescription>Secret access metadata for the selected runtime event.</DialogDescription>
          </DialogHeader>
          {selectedEvent && (
            <DialogBody>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1">
                  <dt className="text-xs text-muted-foreground">Outcome</dt>
                  <dd>
                    <Badge variant="outline" className={cn("capitalize", outcomeClassName(selectedEvent.outcome))}>
                      {selectedEvent.outcome}
                    </Badge>
                  </dd>
                </div>
                <DetailRow label="Provider" value={providerLabel(selectedEvent.provider)} />
                <DetailRow label="Consumer type" value={selectedEvent.consumerType} />
                <DetailRow label="Consumer id" value={selectedEvent.consumerId} />
                <DetailRow label="Actor type" value={selectedEvent.actorType} />
                <DetailRow label="Actor id" value={selectedEvent.actorId} />
                <DetailRow label="Config path" value={selectedEvent.configPath} />
                <DetailRow label="Issue id" value={selectedEvent.issueId} />
                <DetailRow label="Run id" value={selectedEvent.heartbeatRunId} />
                <DetailRow label="Version" value={selectedEvent.version} />
                <DetailRow label="Timestamp" value={formatSecretDate(selectedEvent.createdAt)} />
                {selectedEvent.outcome === "failure" && (
                  <DetailRow label="Error code" value={selectedEvent.errorCode} />
                )}
              </dl>
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
