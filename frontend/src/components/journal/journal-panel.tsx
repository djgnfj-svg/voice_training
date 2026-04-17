"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useJournalSession } from "@/hooks/useJournalSession";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useInactivityTimer } from "@/hooks/useInactivityTimer";
import { useToast } from "@/hooks/useToast";
import { normalizeTranscript } from "@/lib/transcript";
import { getJournalHistory } from "@/lib/journal-api";
import { JournalMessage } from "@/components/journal/journal-message";
import { ModeIndicator } from "@/components/journal/mode-indicator";
import { SessionSummaryCard } from "@/components/journal/session-summary-card";
import { VoiceInputBar } from "@/components/journal/voice-input-bar";
import { MicCheckDialog } from "@/components/interview/mic-check-dialog";
import { Loader2, Square, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const SILENCE_TIMEOUT_MS = 2000;

function stripEmoji(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function JournalPanel() {
  const journal = useJournalSession();
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const { toast } = useToast();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastAiMessageRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTranscriptRef = useRef("");
  const micCheckedRef = useRef(false);
  const journalPhaseRef = useRef(journal.phase);
  journalPhaseRef.current = journal.phase;

  const [voiceState, setVoiceState] = useState<"pending" | "mic_check" | "ready">("pending");
  micCheckedRef.current = voiceState === "ready";

  const liveText = speech.isListening
    ? (speech.transcript + " " + speech.interimTranscript).trim()
    : "";

  // ── Auto-scroll ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [journal.messages, liveText]);

  // ── active 진입 시 마이크 확인 ──
  useEffect(() => {
    if (journal.phase !== "active" || voiceState !== "pending") return;
    setVoiceState("mic_check");
  }, [journal.phase, voiceState]);

  // ── ready → 리스닝 시작 ──
  useEffect(() => {
    if (voiceState !== "ready") return;
    if (journal.phase !== "active") return;
    if (tts.isSpeaking || speech.isListening) return;

    speech.startListening();
  }, [voiceState, journal.phase, tts.isSpeaking, speech.isListening, speech]);

  // ── Inactivity timer ──
  const handleWarning = useCallback(() => {
    toast({
      title: "오늘은 여기까지 할까요?",
      description: "10초 후 자동으로 마무리됩니다.",
    });
  }, [toast]);

  const handleEnd = useCallback(() => {
    speech.stopListening();
    tts.stop();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    journal.end();
  }, [speech, tts, journal]);

  const inactivity = useInactivityTimer({
    timeoutMs: 120000,
    warningMs: 10000,
    onWarning: handleWarning,
    onTimeout: handleEnd,
    enabled: journal.phase === "active" && voiceState === "ready",
  });

  // ── 마이크 확인 완료 ──
  const handleMicConfirm = useCallback(() => {
    setVoiceState("ready");
  }, []);

  // ── 침묵 감지 → 자동 전송 ──
  useEffect(() => {
    if (!speech.isListening) return;

    const currentText = speech.transcript + speech.interimTranscript;
    if (currentText === lastTranscriptRef.current) return;
    lastTranscriptRef.current = currentText;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    // final 또는 interim 어느 쪽이라도 내용이 있으면 타이머 시작
    if (!speech.transcript.trim() && !speech.interimTranscript.trim()) return;

    silenceTimerRef.current = setTimeout(() => {
      // final 우선, 없으면 interim 사용
      const raw = speech.transcript.trim() || speech.interimTranscript.trim();
      if (!raw) return;

      speech.stopListening();
      const normalized = normalizeTranscript(raw);
      speech.resetTranscript();
      lastTranscriptRef.current = "";

      if (!normalized) {
        if (micCheckedRef.current && !tts.isSpeaking) {
          speech.startListening();
        }
        return;
      }

      journal.sendMessage(normalized);
      inactivity.resetTimer();
    }, SILENCE_TIMEOUT_MS);

    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    };
  }, [speech.transcript, speech.interimTranscript, speech.isListening, speech, tts.isSpeaking, journal, inactivity]);

  // ── AI 응답 → TTS → 끝나면 리스닝 재개 ──
  const journalModeRef = useRef(journal.mode);
  journalModeRef.current = journal.mode;
  const { stopListening: speechStop, startListening: speechStart, resetTranscript: speechReset } = speech;
  const { speak: ttsSpeak } = tts;

  useEffect(() => {
    const lastMsg = journal.messages[journal.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    if (lastMsg.content === lastAiMessageRef.current) return;
    lastAiMessageRef.current = lastMsg.content;

    speechStop();

    const ttsText = stripEmoji(lastMsg.content);
    if (!ttsText) return;

    const resumeListening = () => {
      if (journalPhaseRef.current === "active" && micCheckedRef.current) {
        speechReset();
        lastTranscriptRef.current = "";
        speechStart();
      }
    };

    const persona = (lastMsg.mode ?? journalModeRef.current) === "counseling"
      ? "journal_counselor"
      : "journal_friend";
    ttsSpeak(ttsText, { persona }).then(resumeListening).catch(resumeListening);
  }, [journal.messages, speechStop, speechStart, speechReset, ttsSpeak]);

  // ══════════════════════════════════════
  // 렌더링
  // ══════════════════════════════════════

  // ── 로딩 (세션 생성 중) ──
  if (journal.phase === "starting") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── 랜딩 화면 (idle / completed) ──
  if (journal.phase === "idle" || (journal.phase === "completed" && journal.summary)) {
    return <JournalLanding journal={journal} voiceStateRef={{ setVoiceState }} lastAiMessageRef={lastAiMessageRef} />;
  }


  // ── 메인 대화 화면 ──
  return (
    <div className="flex h-full flex-col">
      {/* 마이크 확인 */}
      {voiceState === "mic_check" && (
        <MicCheckDialog
          open
          onOpenChange={() => {}}
          onConfirm={handleMicConfirm}
          loading={false}
          title="마이크 확인"
          description="하루의 정리는 음성으로 진행됩니다. 마이크가 잘 동작하는지 확인해주세요."
          confirmLabel="시작하기"
        />
      )}

      {/* 헤더 */}
      <div className="flex items-center gap-3 border-b px-4 py-3 shrink-0">
        <h1 className="text-lg font-semibold">하루의 정리</h1>
        <ModeIndicator mode={journal.mode} />
      </div>

      {/* 메시지 영역 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {journal.messages.length === 0 && !liveText && voiceState === "ready" && (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            편하게 오늘 하루를 이야기해보세요
          </div>
        )}

        {journal.messages.map((msg, i) => (
          <JournalMessage key={i} role={msg.role} content={msg.content} mode={msg.mode} />
        ))}

        {journal.phase === "responding" && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-muted px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        {liveText && (
          <div className="flex justify-end">
            <div className={cn(
              "max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
              "bg-primary/70 text-primary-foreground",
            )}>
              {liveText}
              <span className="inline-block ml-1 w-0.5 h-4 bg-primary-foreground/60 animate-pulse align-text-bottom" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 에러 */}
      {journal.error && (
        <div className="border-t bg-destructive/10 px-4 py-2 text-sm text-destructive shrink-0">
          {journal.error}
        </div>
      )}

      {/* 하단: 음성 상태 + 마무리 버튼 */}
      <div className="shrink-0 border-t bg-background">
        <VoiceInputBar
          isListening={speech.isListening}
          isSpeaking={tts.isSpeaking}
          isProcessing={journal.phase === "responding"}
        />
        <div className="px-4 pb-4">
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={handleEnd}
            disabled={journal.phase === "summarizing"}
          >
            {journal.phase === "summarizing" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            마무리하기
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 랜딩 화면 (idle + completed 공용) ──
function JournalLanding({
  journal,
  voiceStateRef,
  lastAiMessageRef,
}: {
  journal: ReturnType<typeof useJournalSession>;
  voiceStateRef: { setVoiceState: (v: "pending" | "mic_check" | "ready") => void };
  lastAiMessageRef: React.MutableRefObject<string>;
}) {
  const { data: history } = useQuery({
    queryKey: ["journal-history"],
    queryFn: getJournalHistory,
  });

  const sessions = (history || []).filter((s) => s.summary);

  const handleStart = () => {
    lastAiMessageRef.current = "";
    voiceStateRef.setVoiceState("pending");
    journal.begin();
  };

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <div className="text-center">
        <BookOpen className="mx-auto h-12 w-12 text-primary" />
        <h1 className="mt-4 text-2xl font-bold">하루의 정리</h1>
        <p className="mt-2 text-muted-foreground">
          오늘 하루를 음성으로 되돌아보세요
        </p>
      </div>

      {/* 완료 직후 → 요약 카드 */}
      {journal.phase === "completed" && journal.summary && (
        <SessionSummaryCard summary={journal.summary} />
      )}

      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-8">
          <p className="text-sm text-muted-foreground text-center">
            AI와 대화하며 오늘 하루를 정리하고 기록해보세요
          </p>
          <Button size="lg" className="w-full max-w-xs gap-2" onClick={handleStart}>
            <BookOpen className="h-5 w-5" />
            {journal.phase === "completed" ? "새 대화 시작" : "시작하기"}
          </Button>
        </CardContent>
      </Card>

      {/* 히스토리 인라인 */}
      {sessions.length > 0 && (
        <HistorySection sessions={sessions} />
      )}
    </div>
  );
}

const HISTORY_PREVIEW_COUNT = 5;

function HistorySection({ sessions }: { sessions: { id: string; summary: string | null; messageCount: number; createdAt: string }[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? sessions : sessions.slice(0, HISTORY_PREVIEW_COUNT);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">지난 기록</h2>
      {visible.map((session) => (
        <Card key={session.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">
                {new Date(session.createdAt).toLocaleDateString("ko-KR", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  weekday: "short",
                })}
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {session.messageCount}개 메시지
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm leading-relaxed text-muted-foreground line-clamp-2">
              {session.summary}
            </p>
          </CardContent>
        </Card>
      ))}
      {!showAll && sessions.length > HISTORY_PREVIEW_COUNT && (
        <Button variant="outline" className="w-full" onClick={() => setShowAll(true)}>
          더보기 ({sessions.length - HISTORY_PREVIEW_COUNT}건)
        </Button>
      )}
    </div>
  );
}
