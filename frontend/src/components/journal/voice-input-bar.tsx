"use client";

import { useRef, useState } from "react";
import { Mic, MicOff, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface VoiceInputBarProps {
  onSubmit: (text: string) => void;
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  onStartListening: () => void;
  onStopListening: () => void;
  disabled?: boolean;
}

export function VoiceInputBar({
  onSubmit,
  isListening,
  transcript,
  interimTranscript,
  onStartListening,
  onStopListening,
  disabled = false,
}: VoiceInputBarProps) {
  const [manualText, setManualText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const displayText = isListening
    ? (transcript + " " + interimTranscript).trim()
    : manualText;

  const handleSubmit = () => {
    const text = isListening ? transcript.trim() : manualText.trim();
    if (!text) return;

    if (isListening) {
      onStopListening();
    }
    onSubmit(text);
    setManualText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t bg-card p-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={isListening ? "destructive" : "outline"}
          size="icon"
          className="shrink-0"
          onClick={isListening ? onStopListening : onStartListening}
          disabled={disabled}
        >
          {isListening ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>

        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={displayText}
            onChange={(e) => {
              if (!isListening) setManualText(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? "말씀하세요..." : "텍스트로 입력하기..."}
            disabled={disabled}
            readOnly={isListening}
            className={cn(
              "w-full rounded-lg border bg-background px-4 py-2.5 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-primary/50",
              isListening && "animate-pulse border-red-300 dark:border-red-700",
            )}
          />
        </div>

        <Button
          type="button"
          size="icon"
          className="shrink-0"
          onClick={handleSubmit}
          disabled={disabled || !displayText.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
