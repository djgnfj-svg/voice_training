"use client";

import { cn } from "@/lib/utils";
import { BookOpen, Heart } from "lucide-react";

interface ModeIndicatorProps {
  mode: "journal" | "counseling";
}

export function ModeIndicator({ mode }: ModeIndicatorProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        mode === "journal"
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
          : "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
      )}
    >
      {mode === "journal" ? (
        <BookOpen className="h-3 w-3" />
      ) : (
        <Heart className="h-3 w-3" />
      )}
      {mode === "journal" ? "하루 정리" : "상담"}
    </div>
  );
}
