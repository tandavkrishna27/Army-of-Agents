import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowUpCircle, X } from "lucide-react";
import type { PendingUpdate } from "@/api/marketplace";

interface UpdateCardProps {
  update: PendingUpdate;
  onDismiss: () => void;
  onApply?: () => void;
  onReview?: () => void;
  isPending?: boolean;
}

export function UpdateCard({
  update,
  onDismiss,
  onApply,
  onReview,
  isPending,
}: UpdateCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-3 px-4">
        <div className="flex items-center gap-3 min-w-0">
          <ArrowUpCircle className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{update.catalogItemName}</p>
            <p className="text-xs text-muted-foreground capitalize">
              {update.itemType} &middot; {update.currentVersion} &rarr; {update.latestVersion}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {update.status === "conflict" && (
            <Badge variant="destructive" className="text-xs">
              Conflict
            </Badge>
          )}
          {/*
            No longer plugin-only. `POST /updates/:id/apply` handles skills and
            agents too, and gating the button on `isPlugin` made that branch
            unreachable from the UI — an agent with nothing to review still had
            to go through the merge modal. The panel decides WHICH updates get
            `onApply` (only `pending` ones — a `conflict` row must be reviewed).
          */}
          {onApply && (
            <Button
              size="sm"
              variant="outline"
              onClick={onApply}
              disabled={isPending}
              aria-label={`Update ${update.catalogItemName}`}
            >
              Update
            </Button>
          )}
          {onReview && (
            <Button
              size="sm"
              variant="outline"
              onClick={onReview}
              disabled={isPending}
              aria-label={`Review ${update.catalogItemName}`}
            >
              Review
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onDismiss}
            disabled={isPending}
            aria-label={`Dismiss ${update.catalogItemName} update`}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
