import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  /** Short message or title displayed prominently */
  message: string;
  /** Optional longer description below the title */
  description?: string;
  /** CTA button label */
  action?: string;
  onAction?: () => void;
  /** Entity accent color (CSS variable, e.g. "var(--entity-task)") for icon tint */
  entityColor?: string;
}

export function EmptyState({ icon: Icon, message, description, action, onAction, entityColor }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted/50 p-5 rounded-xl mb-4">
        <Icon
          className="h-12 w-12"
          style={entityColor ? { color: entityColor, opacity: 0.7 } : { color: "var(--muted-foreground)", opacity: 0.5 }}
        />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">{message}</p>
      {description && (
        <p className="text-xs text-muted-foreground max-w-xs mb-4">{description}</p>
      )}
      {action && onAction && (
        <Button onClick={onAction} className="mt-2">
          <Plus className="h-4 w-4 mr-1.5" />
          {action}
        </Button>
      )}
    </div>
  );
}
