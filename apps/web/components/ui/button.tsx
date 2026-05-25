import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-sm border border-accent bg-accent px-3 text-sm font-semibold text-background hover:bg-background hover:text-accent disabled:cursor-not-allowed disabled:border-border disabled:bg-panel disabled:text-muted",
        className
      )}
      {...props}
    />
  );
}
