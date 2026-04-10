"use client";

import { cn } from "@/lib/utils";

interface JournalMessageProps {
  role: "user" | "assistant";
  content: string;
  mode: "journal" | "counseling";
}

export function JournalMessage({ role, content, mode }: JournalMessageProps) {
  const isUser = role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : mode === "counseling"
              ? "bg-violet-100 text-violet-900 dark:bg-violet-900/30 dark:text-violet-100"
              : "bg-muted text-foreground",
        )}
      >
        {content}
      </div>
    </div>
  );
}
