import * as React from "react"
import { Avatar as AvatarPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { avatarColorFor, initialsFor } from "@/lib/avatar-color"

/**
 * AoA Avatar — design system §11.
 *
 * Five canonical sizes (xs/sm/md/lg/xl per spec §11). `default` is preserved as
 * an alias for `md` so existing call sites (UserMenu, Identity) keep working.
 *
 * Two ways to use:
 *
 *   1. Children mode (legacy / explicit):
 *      <Avatar size="md">
 *        <AvatarImage src="…" alt="…" />
 *        <AvatarFallback>JD</AvatarFallback>
 *      </Avatar>
 *
 *   2. Helper-prop mode (new — auto-derives initials + dept-colored bg):
 *      <Avatar size="md" name="Research Lead" seed="research-lead" />
 *      <Avatar size="md" name="Jane Doe" seed={user.id} src={user.avatarUrl} />
 *
 * In helper-prop mode, `seed` selects a deterministic color from the data
 * palette (`--data-*`) and `name` produces the initials. `src` is optional —
 * when present, the image is rendered and falls back to the initials block on
 * load failure (Radix handles the swap).
 */

const SIZE_CLASSES: Record<AvatarSize, string> = {
  // xs = 18px (spec §11). No Tailwind 18px utility — arbitrary value.
  xs: "size-[18px] text-[10px]",
  sm: "size-6 text-xs",        // 24px — list rows / table rows
  md: "size-8 text-sm",        // 32px — default
  default: "size-8 text-sm",   // alias for md (legacy callers)
  lg: "size-10 text-sm",       // 40px — profile, settings header
  xl: "size-14 text-lg",       // 56px — profile detail page
}

export type AvatarSize = "xs" | "sm" | "md" | "default" | "lg" | "xl"
export type AvatarShape = "circle" | "squircle"

const SHAPE_CLASSES: Record<AvatarShape, string> = {
  circle: "rounded-full",
  squircle: "rounded-[28%]",
}

interface AvatarProps extends React.ComponentProps<typeof AvatarPrimitive.Root> {
  size?: AvatarSize
  /** Visual shape — default `circle` (people / generic), `squircle` for app/brand icons. */
  shape?: AvatarShape
  /** Stable seed used to pick a dept color from the data palette (helper mode). */
  seed?: string
  /** Display name — derives initials per §11 rules (helper mode). */
  name?: string
  /** Optional image src — Radix falls back to initials if it fails to load. */
  src?: string
}

function Avatar({
  className,
  size = "md",
  shape = "circle",
  seed,
  name,
  src,
  children,
  ...props
}: AvatarProps) {
  // Helper-prop mode triggers when any of seed/name/src is provided. Otherwise
  // we fall through to children, preserving the legacy children-based API used
  // by UserMenu, Identity, HumansTab, etc.
  const useHelpers = seed !== undefined || name !== undefined || src !== undefined
  const sizeClass = SIZE_CLASSES[size] ?? SIZE_CLASSES.md
  const shapeClass = SHAPE_CLASSES[shape] ?? SHAPE_CLASSES.circle
  // Normalize data-size for downstream selectors (AvatarBadge group-data-*).
  // "default" is canonicalized to "md" so any new selectors only need to know
  // the spec sizes; legacy size="default" still produces data-size="md".
  const dataSize = size === "default" ? "md" : size

  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={dataSize}
      data-shape={shape}
      className={cn(
        "group/avatar relative flex shrink-0 overflow-hidden select-none",
        shapeClass,
        sizeClass,
        className,
      )}
      {...props}
    >
      {useHelpers ? (
        <>
          {src ? (
            <AvatarPrimitive.Image
              data-slot="avatar-image"
              src={src}
              alt={name ?? ""}
              className="aspect-square size-full object-cover"
            />
          ) : null}
          <AvatarPrimitive.Fallback
            data-slot="avatar-fallback"
            className="flex size-full items-center justify-center font-bold tracking-[-0.01em] text-white"
            style={{
              backgroundColor: seed ? avatarColorFor(seed) : "var(--data-slate)",
            }}
          >
            {name ? initialsFor(name) : "?"}
          </AvatarPrimitive.Fallback>
        </>
      ) : (
        children
      )}
    </AvatarPrimitive.Root>
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  // No `rounded-*` here — the parent Avatar root owns the shape (circle vs
  // squircle) via `overflow-hidden` + `rounded-full|rounded-[28%]`. Setting
  // a radius on the fallback would create a circular fill clipped to a
  // squircle shape, which still renders as a visible circle.
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-muted text-muted-foreground flex size-full items-center justify-center text-sm group-data-[size=sm]/avatar:text-xs group-data-[size=xs]/avatar:text-[10px]",
        className
      )}
      {...props}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "bg-primary text-primary-foreground ring-background absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full ring-2 select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        // "default" is canonicalized to "md" upstream, so md selectors cover both.
        "group-data-[size=md]/avatar:size-2.5 group-data-[size=md]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "*:data-[slot=avatar]:ring-background group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "bg-muted text-muted-foreground ring-background relative flex size-8 shrink-0 items-center justify-center rounded-full text-sm ring-2 group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
}
