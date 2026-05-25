import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-12 items-center justify-center rounded-sm border px-2 text-xs font-semibold uppercase tracking-normal",
        className
      )}
      {...props}
    />
  );
}
