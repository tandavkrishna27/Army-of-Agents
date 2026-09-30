import { forwardRef, type ComponentPropsWithoutRef, type KeyboardEvent } from "react";

/**
 * A div that behaves like a button for accessibility.
 * Adds role="button", tabIndex=0, and Enter/Space key handlers automatically
 * when an onClick is provided. Note: the onKeyDown handler fires onClick with
 * a keyboard event (not a mouse event), so onClick handlers should not rely on
 * mouse-specific properties like clientX/clientY.
 */
export const ClickableDiv = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  ({ onClick, onKeyDown, role, tabIndex, ...props }, ref) => {
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if ((e.key === "Enter" || e.key === " ") && onClick) {
        e.preventDefault();
        onClick(e as any);
      }
      onKeyDown?.(e);
    };

    return (
      <div
        ref={ref}
        role={role ?? (onClick ? "button" : undefined)}
        tabIndex={tabIndex ?? (onClick ? 0 : undefined)}
        onClick={onClick}
        onKeyDown={onClick ? handleKeyDown : onKeyDown}
        {...props}
      />
    );
  },
);

ClickableDiv.displayName = "ClickableDiv";
