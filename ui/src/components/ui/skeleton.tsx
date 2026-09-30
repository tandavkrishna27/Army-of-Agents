import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md animate-shimmer",
        "bg-gradient-to-r from-field via-card-2 to-field",
        "bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
