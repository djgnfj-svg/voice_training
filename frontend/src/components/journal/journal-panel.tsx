"use client";

import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useJournalSession } from "@/hooks/useJournalSession";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useInactivityTimer } from "@/hooks/useInactivityTimer";
import { useToast } from "@/hooks/useToast";
import { normalizeTranscript } from "@/lib/transcript";
import { JournalMessage } from "@/components/journal/journal-message";
import { ModeIndicator } from "@/components/journal/mode-indicator";
import { SessionSummaryCard } from "@/components/journal/session-summary-card";
import { VoiceInputBar } from "@/components/journal/voice-input-bar";
import { Loader2, Square } from "lucide-react";

export function JournalPanel() {
  const journal = useJournalSession();
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const { toast } = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const lastAiMessageRef = useRef<string>("");

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [journal.messages]);

  // Start session on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    journal.start();
  }, [journal.start]);

  // TTS for AI responses
  useEffect(() => {
    const lastMsg = journal.messages[journal.messages.length - 1];
    if (
      lastMsg?.role === "assistant" &&
      lastMsg.content !== lastAiMessageRef.current
    ) {
      lastAiMessageRef.current = lastMsg.content;
      tts.speak(lastMsg.content);
    }
  }, [journal.messages, tts]);

  // Inactivity timer
  const handleWarning = useCallback(() => {
    toast({
      title: "오늘은 여기까지 할까요?",
      description: "10초 후 자동으로 마무리됩니다.",
    });
  }, [toast]);

  const inactivity = useInactivityTimer({
    timeoutMs: 120000,
    warningMs: 10000,
    onWarning: handleWarning,
    onTimeout: journal.end,
    enabled: journal.phase === "active",
  });

  const handleSubmit = useCallback(
    (text: string) => {
      const normalized = normalizeTranscript(text);
      if (!normalized) return;
      journal.sendMessage(normalized);
      speech.resetTranscript();
      inactivity.resetTimer();
    },
    [journal, speech, inactivity],
  );

  // Completed state — show summary
  if (journal.phase === "completed" && journal.summary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        <SessionSummaryCard summary={journal.summary} />
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => {
            startedRef.current = false;
            journal.start();
          }}
        >
          새 대화 시작
        </Button>
      </div>
    );
  }

  // Loading state
  if (journal.phase === "starting" || journal.phase === "idle") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">하루의 정리</h1>
          <ModeIndicator mode={journal.mode} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={journal.end}
          disabled={journal.phase === "summarizing"}
        >
          {journal.phase === "summarizing" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Square className="mr-1 h-3 w-3" />
          )}
          마무리
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {journal.messages.length === 0 && journal.phase === "active" && (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            마이크를 누르고 오늘 하루를 이야기해보세요
          </div>
        )}
        {journal.messages.map((msg, i) => (
          <JournalMessage key={i} role={msg.role} content={msg.content} mode={msg.mode} />
        ))}
        {journal.phase === "responding" && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-muted px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {journal.error && (
        <div className="border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {journal.error}
        </div>
      )}

      {/* Voice Input */}
      <VoiceInputBar
        onSubmit={handleSubmit}
        isListening={speech.isListening}
        transcript={speech.transcript}
        interimTranscript={speech.interimTranscript}
        onStartListening={speech.startListening}
        onStopListening={speech.stopListening}
        disabled={journal.phase !== "active"}
      />
    </div>
  );
}
