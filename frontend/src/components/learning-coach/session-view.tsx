'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Loader2, X, Volume2, VolumeX, PhoneOff, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useLearningCoachStream } from '@/hooks/useLearningCoachStream';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useTextToSpeech } from '@/hooks/useTextToSpeech';
import { useRealtimeVoice } from '@/hooks/useRealtimeVoice';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { TextAnswerInput } from '@/components/admin/text-answer-input';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  sessionId: string;
  firstMessage: string;
  currentTopic: string | null;
  onEnd: () => Promise<void>;
}

const SILENCE_MS = 3000;
const MIC_RETRY_MAX = 3;
const MIC_RETRY_DELAY_MS = 1000;

// 모듈 스코프: StrictMode 이중 mount에서도 세션별 재생 이력을 유지해 중복 TTS를 막는다.
const spokenBySession = new Map<string, Set<string>>();

export function SessionView({ sessionId, firstMessage, currentTopic, onEnd }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: firstMessage },
  ]);
  const [currentTopicLabel, setCurrentTopicLabel] = useState<string | null>(currentTopic);
  const [shouldSuggestEnd, setShouldSuggestEnd] = useState(false);
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [phase, setPhase] = useState<{ phase: string; label: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHeardRef = useRef<string>('');
  const micRetryRef = useRef(0);
  const micRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isAdmin = useIsAdmin();
  const [textMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('textMode') === '1';
  });

  // Realtime voice은 textMode가 아닐 때만 시도한다. 연결 실패/미지원/킬스위치 off면
  // onUnavailable이 realtimeActive=false로 떨어뜨려 기존 턴제 루프로 graceful degradation.
  const [realtimeActive, setRealtimeActive] = useState<boolean>(!textMode);

  const tts = useTextToSpeech({ persona: 'tutor' });
  const { speak: ttsSpeak, stop: ttsStop, isSpeaking: isAiSpeaking } = tts;

  const realtime = useRealtimeVoice({
    sessionId,
    onTranscript: (t) => {
      setMessages((prev) => [...prev, { role: t.role, content: t.text }]);
    },
    onMeta: (meta) => {
      const node = (meta.result?.target_node ?? null) as { title?: string } | null;
      if (node?.title) setCurrentTopicLabel(node.title);
    },
    onGuard: (g) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: g.message }]);
    },
    onUnavailable: () => {
      // 실시간 음성 불가 → 턴제 루프로 폴백 (메시지 흐름은 유지).
      setRealtimeActive(false);
    },
  });
  const { status: realtimeStatus, start: startRealtime, hangup: hangupRealtime } = realtime;

  const endedRef = useRef(false);
  const finishWithError = useCallback((msg: string) => {
    if (endedRef.current) return;
    endedRef.current = true;
    setMessages((prev) => [...prev, { role: 'assistant', content: `⚠ ${msg}` }]);
    void onEnd().catch(() => {});
  }, [onEnd]);

  const speech = useSpeechRecognition({
    onFatalError: (err) => {
      const msg =
        err === 'not-allowed'
          ? '마이크 권한이 거부되어 세션을 종료합니다.'
          : err === 'audio-capture'
          ? '마이크를 찾지 못해 세션을 종료합니다.'
          : '음성인식을 사용할 수 없어 세션을 종료합니다.';
      finishWithError(msg);
    },
  });
  const {
    isListening,
    startListening,
    stopListening,
    transcript,
    interimTranscript,
    resetTranscript,
  } = speech;

  const { isStreaming, sendTurn } = useLearningCoachStream({
    sessionId,
    onText: (text) => {
      setPhase(null);
      setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
    },
    onMeta: (meta) => {
      if (meta.nodeChangedTo) setCurrentTopicLabel(meta.nodeChangedTo.title);
      if (meta.shouldSuggestEnd) setShouldSuggestEnd(true);
    },
    onPhase: (p) => {
      setPhase({ phase: p.phase, label: p.label });
    },
    onError: (msg) => {
      setPhase(null);
      setMessages((prev) => [...prev, { role: 'assistant', content: `⚠ ${msg}` }]);
    },
    onEnd: () => {
      setPhase(null);
    },
  });

  const tryStartMic = useCallback(() => {
    if (endedRef.current) return;
    if (micRetryTimerRef.current) {
      clearTimeout(micRetryTimerRef.current);
      micRetryTimerRef.current = null;
    }
    const started = startListening();
    if (started) {
      micRetryRef.current = 0;
      return;
    }
    if (micRetryRef.current < MIC_RETRY_MAX) {
      micRetryRef.current += 1;
      micRetryTimerRef.current = setTimeout(() => tryStartMic(), MIC_RETRY_DELAY_MS);
    } else {
      finishWithError('마이크를 시작하지 못해 세션을 종료합니다.');
    }
  }, [startListening, finishWithError]);

  const handleSend = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? transcript).trim();
    if (!text || isStreaming) return;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setCountdownSec(null);
    lastHeardRef.current = '';
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    resetTranscript();
    stopListening();
    await sendTurn(text);
  }, [transcript, isStreaming, resetTranscript, stopListening, sendTurn]);

  // 최신 handleSend를 setTimeout 콜백에서 참조 (stale closure 방지)
  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, interimTranscript]);

  // AI 메시지가 추가되면 TTS 재생 후 자동으로 듣기 시작 (턴제 폴백 경로 전용)
  useEffect(() => {
    if (textMode || realtimeActive) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;

    let spoken = spokenBySession.get(sessionId);
    if (!spoken) {
      spoken = new Set<string>();
      spokenBySession.set(sessionId, spoken);
    }
    if (spoken.has(last.content)) return;
    spoken.add(last.content);

    (async () => {
      try {
        await ttsSpeak(last.content);
      } catch {
        // abort 또는 재생 실패 — listening으로 진행
      }
      resetTranscript();
      lastHeardRef.current = '';
      tryStartMic();
    })();
  }, [messages, sessionId, ttsSpeak, resetTranscript, tryStartMic, textMode, realtimeActive]);

  // 세션 종료 시 모듈 캐시 정리
  useEffect(() => {
    return () => {
      spokenBySession.delete(sessionId);
    };
  }, [sessionId]);

  // AI 발화 시작 시 듣기 중지 (턴제 폴백 경로 전용)
  useEffect(() => {
    if (textMode || realtimeActive) return;
    if (isAiSpeaking && isListening) {
      stopListening();
      resetTranscript();
      lastHeardRef.current = '';
    }
  }, [isAiSpeaking, isListening, stopListening, resetTranscript, textMode, realtimeActive]);

  // 무음 감지 → 자동 전송
  // interim이 있으면 사용자가 말하는 중 → 타이머 취소.
  // interim 비었고 transcript 확정본이 있으면 → 말 멈춤, 타이머 시작.
  useEffect(() => {
    const cancel = () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      setCountdownSec(null);
    };

    if (textMode || realtimeActive) {
      cancel();
      return;
    }

    if (!isListening || isStreaming) {
      cancel();
      return;
    }

    const hasFinal = transcript.trim().length > 0;
    const isSpeaking = interimTranscript.trim().length > 0;

    if (!hasFinal || isSpeaking) {
      cancel();
      return;
    }

    // 이미 카운트 중이면 유지 (transcript가 한 번 더 final로 커져도 새 타이머 안 시작)
    if (silenceTimerRef.current) return;

    setCountdownSec(Math.ceil(SILENCE_MS / 1000));
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      setCountdownSec(null);
      void handleSendRef.current?.();
    }, SILENCE_MS);
  }, [transcript, interimTranscript, isListening, isStreaming, textMode, realtimeActive]);

  // 카운트다운 초 단위 감소 (표시용)
  useEffect(() => {
    if (countdownTickRef.current) {
      clearTimeout(countdownTickRef.current);
      countdownTickRef.current = null;
    }
    if (countdownSec === null || countdownSec <= 0) return;
    countdownTickRef.current = setTimeout(() => {
      setCountdownSec((c) => (c === null ? null : Math.max(0, c - 1)));
    }, 1000);
    return () => {
      if (countdownTickRef.current) {
        clearTimeout(countdownTickRef.current);
        countdownTickRef.current = null;
      }
    };
  }, [countdownSec]);

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (micRetryTimerRef.current) clearTimeout(micRetryTimerRef.current);
      ttsStop();
    };
  }, [ttsStop]);

  // Realtime 음성 세션 기동 (textMode 아니고 realtime 활성일 때 1회).
  // 실패/미지원/킬스위치 off → onUnavailable이 realtimeActive=false로 떨어뜨려 턴제 폴백.
  const realtimeStartedRef = useRef(false);
  useEffect(() => {
    if (textMode || !realtimeActive || realtimeStartedRef.current) return;
    realtimeStartedRef.current = true;
    void startRealtime();
  }, [textMode, realtimeActive, startRealtime]);

  // 세션 종료 시 realtime WS도 정리.
  useEffect(() => {
    return () => {
      hangupRealtime();
    };
  }, [hangupRealtime]);

  const showInterim =
    !textMode && !realtimeActive && isListening && (transcript || interimTranscript);
  const realtimeLive = realtimeActive && realtimeStatus === 'live';
  const realtimeConnecting = realtimeActive && realtimeStatus === 'connecting';

  return (
    <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-background">
      {isAdmin && textMode && (
        <div
          data-testid="admin-text-mode-active"
          className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        >
          Admin 텍스트 모드 활성 (URL ?textMode=1)
        </div>
      )}

      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Mic className="h-5 w-5 shrink-0 text-primary" />
          {currentTopicLabel ? (
            <Badge variant="secondary" className="truncate">
              {currentTopicLabel}
            </Badge>
          ) : (
            <span className="truncate text-sm text-muted-foreground">오늘의 학습</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 sm:flex">
            <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={tts.volume}
              onChange={(e) => tts.setVolume(Number(e.target.value))}
              aria-label="음량 조절"
              className="h-1 w-24 cursor-pointer accent-primary"
            />
            <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
              {Math.round(tts.volume * 100)}%
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={onEnd}>
            <X className="mr-1 h-4 w-4" /> 종료
          </Button>
        </div>
      </header>

      {/* Conversation */}
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-6">
          {messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed',
                m.role === 'user'
                  ? 'ml-auto bg-primary text-primary-foreground'
                  : 'bg-muted'
              )}
            >
              {m.content}
            </div>
          ))}
          {showInterim ? (
            <div className="ml-auto max-w-[85%] rounded-2xl bg-primary/15 px-4 py-3 text-sm text-primary">
              {transcript}
              {interimTranscript ? (
                <span className="opacity-60">
                  {transcript ? ' ' : ''}
                  {interimTranscript}
                </span>
              ) : null}
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </main>

      {shouldSuggestEnd ? (
        <div className="shrink-0 border-t border-amber-200 bg-amber-50 p-2 text-center text-xs text-amber-900">
          AI가 오늘 여기까지 정리하자고 제안했어요
        </div>
      ) : null}

      {/* Status */}
      <footer className="shrink-0 border-t pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          <Card>
            <CardContent className="flex min-h-[92px] items-center justify-center py-5">
              {isAdmin && textMode ? (
                <div className="w-full">
                  <TextAnswerInput
                    onSubmit={(text) => void handleSend(text)}
                    disabled={isStreaming}
                  />
                </div>
              ) : realtimeConnecting ? (
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">음성 통화 연결 중…</span>
                </div>
              ) : realtimeLive ? (
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 ring-4 ring-green-100/50 dark:bg-green-900/30 dark:ring-green-900/30">
                    <Radio className="h-5 w-5 animate-pulse text-green-600 dark:text-green-400" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-green-600 dark:text-green-400">
                      실시간 음성 통화 중
                    </span>
                    <button
                      onClick={() => {
                        hangupRealtime();
                        void onEnd();
                      }}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <PhoneOff className="h-3 w-3" /> 통화 종료
                    </button>
                  </div>
                </div>
              ) : isAiSpeaking ? (
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <Volume2 className="h-5 w-5 animate-pulse text-primary" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">AI가 말하는 중</span>
                    <button
                      onClick={ttsStop}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <VolumeX className="h-3 w-3" /> 건너뛰기
                    </button>
                  </div>
                </div>
              ) : isStreaming ? (
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">
                    {phase?.label ?? '생각 중…'}
                  </span>
                </div>
              ) : isListening ? (
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 ring-4 ring-red-100/50 dark:bg-red-900/30 dark:ring-red-900/30">
                    <Mic className="h-5 w-5 animate-pulse text-red-500 dark:text-red-400" />
                  </div>
                  <span className="text-sm font-medium text-red-500 dark:text-red-400 tabular-nums">
                    {countdownSec !== null
                      ? `${countdownSec}초 후 자동 전송…`
                      : transcript.trim().length > 0
                      ? '말 멈추면 자동 전송'
                      : '말씀하세요'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">마이크 준비 중…</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </footer>
    </div>
  );
}
