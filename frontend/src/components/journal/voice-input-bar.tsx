"use client";

import { cn } from "@/lib/utils";

interface VoiceInputBarProps {
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
}

export function VoiceInputBar({
  isListening,
  isSpeaking,
  isProcessing,
}: VoiceInputBarProps) {
  const label = isProcessing
    ? "생각하고 있어요..."
    : isSpeaking
      ? "이야기하고 있어요..."
      : isListening
        ? "듣고 있어요..."
        : "대기 중...";

  return (
    <div className="flex items-center justify-center gap-3 py-4">
      <div className="relative flex items-center justify-center">
        {/* 외곽 펄스 */}
        {isListening && (
          <span className="absolute h-4 w-4 animate-ping rounded-full bg-red-400 opacity-50" />
        )}
        {isSpeaking && (
          <span className="absolute h-4 w-4 animate-ping rounded-full bg-primary opacity-50" />
        )}
        {/* 내부 점 */}
        <span
          className={cn(
            "relative h-3 w-3 rounded-full transition-colors",
            isProcessing
              ? "bg-amber-500 animate-pulse"
              : isSpeaking
                ? "bg-primary"
                : isListening
                  ? "bg-red-500"
                  : "bg-muted-foreground/30",
          )}
        />
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
