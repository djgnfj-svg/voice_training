"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { MicCheckDialog } from "@/components/interview/mic-check-dialog";
import { Loader2, Square, ArrowLeft, Play, Plus, BookOpen } from "lucide-react";
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
  const startedRef = useRef(false);
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

  // ── 1단계: 세션 시작 (마운트 시 1회) ──
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    journal.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal.start]);

  // ── 2단계: active 진입 시 마이크 흐름 결정 ──
  useEffect(() => {
    if (journal.phase !== "active" || voiceState !== "pending") return;

    if (journal.resumed) {
      // 이어하기 → 마이크 체크 스킵
      setVoiceState("ready");
    } else {
      // 신규 → 마이크 확인
      setVoiceState("mic_check");
    }
  }, [journal.phase, journal.resumed, voiceState]);

  // ── 3단계: ready → 리스닝 시작 ──
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

    if (!speech.transcript.trim()) return;

    silenceTimerRef.current = setTimeout(() => {
      const text = speech.transcript.trim();
      if (!text) return;

      speech.stopListening();
      const normalized = normalizeTranscript(text);
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
  useEffect(() => {
    const lastMsg = journal.messages[journal.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    if (lastMsg.content === lastAiMessageRef.current) return;
    lastAiMessageRef.current = lastMsg.content;

    speech.stopListening();

    const ttsText = stripEmoji(lastMsg.content);
    if (!ttsText) return;

    const resumeListening = () => {
      if (journalPhaseRef.current === "active" && micCheckedRef.current) {
        speech.resetTranscript();
        lastTranscriptRef.current = "";
        speech.startListening();
      }
    };

    tts.speak(ttsText).then(resumeListening).catch(resumeListening);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal.messages]);

  // ══════════════════════════════════════
  // 렌더링
  // ══════════════════════════════════════

  // ── 로딩 ──
  if (journal.phase === "idle" || journal.phase === "starting") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── 이전 세션 발견 → 선택 화면 ──
  if (journal.phase === "choose") {
    return (
      <div className="mx-auto max-w-lg space-y-6 p-6">
        <div className="text-center">
          <BookOpen className="mx-auto h-12 w-12 text-primary" />
          <h1 className="mt-4 text-2xl font-bold">하루의 정리</h1>
          <p className="mt-2 text-muted-foreground">
            오늘 하루를 음성으로 되돌아보세요
          </p>
        </div>

        <Card>
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-lg">이전 대화가 있어요</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              오늘 나눴던 대화를 이어할 수 있어요
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button onClick={journal.resumeSession} size="lg" className="w-full gap-2">
              <Play className="h-4 w-4" />
              이어서 하기
            </Button>
            <Button onClick={journal.startFresh} variant="outline" size="lg" className="w-full gap-2">
              <Plus className="h-4 w-4" />
              새로 시작
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── 완료 화면 ──
  if (journal.phase === "completed" && journal.summary) {
    return (
      <div className="mx-auto max-w-lg space-y-6 p-6">
        <div className="text-center">
          <BookOpen className="mx-auto h-12 w-12 text-primary" />
          <h1 className="mt-4 text-2xl font-bold">하루의 정리</h1>
          <p className="mt-2 text-muted-foreground">
            오늘의 기록이 저장되었습니다
          </p>
        </div>

        <SessionSummaryCard summary={journal.summary} />

        <div className="flex gap-3 justify-center">
          <Link href="/dashboard">
            <Button variant="outline" size="lg">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              돌아가기
            </Button>
          </Link>
          <Button
            size="lg"
            onClick={() => {
              startedRef.current = false;
              lastAiMessageRef.current = "";
              setVoiceState("pending");
              journal.start();
            }}
          >
            새 대화 시작
          </Button>
        </div>
      </div>
    );
  }

  // ── 메인 대화 화면 ──
  return (
    <div className="flex h-full flex-col">
      {/* 마이크 확인 (신규 세션만) */}
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
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">하루의 정리</h1>
          <ModeIndicator mode={journal.mode} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleEnd}
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

      {/* 음성 상태 인디케이터 */}
      <div className="shrink-0">
        <VoiceInputBar
          isListening={speech.isListening}
          isSpeaking={tts.isSpeaking}
          isProcessing={journal.phase === "responding"}
        />
      </div>
    </div>
  );
}
