"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Dialog({ children, ...props }: DialogPrimitive.DialogProps) {
  return <DialogPrimitive.Root {...props}>{children}</DialogPrimitive.Root>;
}

export function DialogTrigger({ children }: { children: ReactNode }) {
  return <DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>;
}

export function DialogContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 max-h-screen w-11/12 max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md border border-border bg-panel p-4",
          className
        )}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 rounded-sm border border-border p-1 text-muted hover:text-foreground">
          <X className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
