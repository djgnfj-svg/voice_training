'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Loader2, X, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useNightlyStudyStream } from '@/hooks/useNightlyStudyStream';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';

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

const SILENCE_MS = 2500; // 2.5초 무음 시 자동 전송

export function SessionView({ sessionId, firstMessage, currentTopic, onEnd }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: firstMessage },
  ]);
  const [currentTopicLabel, setCurrentTopicLabel] = useState<string | null>(currentTopic);
  const [shouldSuggestEnd, setShouldSuggestEnd] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHeardRef = useRef<string>('');

  const {
    isListening,
    startListening,
    stopListening,
    transcript,
    interimTranscript,
    resetTranscript,
  } = useSpeechRecognition();

  const { isStreaming, sendTurn } = useNightlyStudyStream({
    sessionId,
    onText: (text) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
      setIsAiSpeaking(true);
      playTTS(text, () => setIsAiSpeaking(false));
    },
    onMeta: (meta) => {
      if (meta.nodeChangedTo) setCurrentTopicLabel(meta.nodeChangedTo.title);
      if (meta.shouldSuggestEnd) setShouldSuggestEnd(true);
    },
    onError: (msg) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: `⚠ ${msg}` }]);
    },
    onEnd: () => {},
  });

  const handleSend = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? transcript).trim();
    if (!text || isStreaming) return;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    lastHeardRef.current = '';
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    resetTranscript();
    stopListening();
    await sendTurn(text);
  }, [transcript, isStreaming, resetTranscript, stopListening, sendTurn]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, interimTranscript]);

  // 첫 메시지 TTS 재생
  const firstMessageRef = useRef(firstMessage);
  useEffect(() => {
    const text = firstMessageRef.current;
    setIsAiSpeaking(true);
    playTTS(text, () => setIsAiSpeaking(false));
  }, []);

  // AI 발화 끝나면 자동 듣기 시작
  useEffect(() => {
    if (!isAiSpeaking && !isListening && !isStreaming) {
      startListening();
    }
    // AI가 다시 말하기 시작하면 듣기 중지
    if (isAiSpeaking && isListening) {
      stopListening();
      resetTranscript();
      lastHeardRef.current = '';
    }
  }, [isAiSpeaking, isStreaming, isListening, startListening, stopListening, resetTranscript]);

  // 무음 감지 → 자동 전송
  useEffect(() => {
    if (!isListening) return;
    const combined = transcript + interimTranscript;
    if (combined === lastHeardRef.current) return;
    lastHeardRef.current = combined;

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    if (transcript.trim().length > 0) {
      silenceTimerRef.current = setTimeout(() => {
        handleSend();
      }, SILENCE_MS);
    }
  }, [transcript, interimTranscript, isListening, handleSend]);

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  const showInterim = isListening && (transcript || interimTranscript);

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col h-[100dvh]">
      <header className="flex items-center justify-between border-b p-3 shrink-0">
        {currentTopicLabel ? (
          <Badge variant="secondary">{currentTopicLabel}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">
            {isAiSpeaking ? 'AI가 말하는 중...' : isListening ? '듣는 중...' : '대화 중'}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onEnd}>
          <X className="h-4 w-4 mr-1" /> 종료
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto px-3 py-4 space-y-3 min-h-0">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === 'user'
                ? 'ml-auto bg-primary text-primary-foreground'
                : 'bg-muted'
            }`}
          >
            {m.content}
          </div>
        ))}
        {showInterim ? (
          <div className="max-w-[85%] ml-auto rounded-lg px-3 py-2 text-sm bg-primary/20 text-primary">
            {transcript}
            {interimTranscript ? (
              <span className="opacity-60">{transcript ? ' ' : ''}{interimTranscript}</span>
            ) : null}
          </div>
        ) : null}
        <div ref={bottomRef} />
      </main>

      {shouldSuggestEnd ? (
        <div className="bg-amber-50 border-t border-amber-200 p-2 text-xs text-center text-amber-900 shrink-0">
          AI가 오늘 여기까지 정리하자고 제안했어요
        </div>
      ) : null}

      <footer className="border-t p-3 shrink-0 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <div className="flex items-center justify-center gap-3 h-14">
          {isAiSpeaking ? (
            <>
              <Volume2 className="h-5 w-5 text-primary animate-pulse" />
              <span className="text-sm text-muted-foreground">AI가 말하는 중...</span>
            </>
          ) : isStreaming ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">생각 중...</span>
            </>
          ) : isListening ? (
            <>
              <Mic className="h-5 w-5 text-primary animate-pulse" />
              <span className="text-sm text-muted-foreground">
                {transcript.trim().length > 0 ? '말 멈추면 자동 전송' : '말씀하세요'}
              </span>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={startListening}>
              <Mic className="h-4 w-4 mr-1" /> 듣기 시작
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

let currentAudio: HTMLAudioElement | null = null;

async function playTTS(text: string, onDone?: () => void) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, persona: 'tutor' }),
    });
    if (!res.ok) {
      onDone?.();
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      onDone?.();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      onDone?.();
    };
    await audio.play();
  } catch {
    onDone?.();
  }
}
