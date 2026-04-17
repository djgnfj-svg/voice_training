'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, StopCircle, X } from 'lucide-react';
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

export function SessionView({ sessionId, firstMessage, currentTopic, onEnd }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: firstMessage },
  ]);
  const [currentTopicLabel, setCurrentTopicLabel] = useState<string | null>(currentTopic);
  const [shouldSuggestEnd, setShouldSuggestEnd] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { isListening, startListening, stopListening, transcript, resetTranscript } = useSpeechRecognition();

  const speak = (text: string) => {
    setIsAiSpeaking(true);
    playTTS(text, () => setIsAiSpeaking(false));
  };

  const { isStreaming, sendTurn } = useNightlyStudyStream({
    sessionId,
    onText: (text) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
      speak(text);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const firstMessageRef = useRef(firstMessage);
  useEffect(() => {
    const text = firstMessageRef.current;
    setIsAiSpeaking(true);
    playTTS(text, () => setIsAiSpeaking(false));
  }, []);

  const handleSend = async () => {
    const text = transcript.trim();
    if (!text || isStreaming) return;
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    resetTranscript();
    stopListening();
    await sendTurn(text);
  };

  const micDisabled = isStreaming || isAiSpeaking;

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col h-[100dvh]">
      <header className="flex items-center justify-between border-b p-3 shrink-0">
        {currentTopicLabel ? (
          <Badge variant="secondary">{currentTopicLabel}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">
            {isAiSpeaking ? 'AI가 말하는 중...' : '대화 중'}
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
        {isListening && transcript ? (
          <div className="max-w-[85%] ml-auto rounded-lg px-3 py-2 text-sm bg-primary/20 text-primary">
            {transcript}
          </div>
        ) : null}
        <div ref={bottomRef} />
      </main>

      {shouldSuggestEnd ? (
        <div className="bg-amber-50 border-t border-amber-200 p-2 text-xs text-center text-amber-900 shrink-0">
          AI가 오늘 여기까지 정리하자고 제안했어요
        </div>
      ) : null}

      <footer className="border-t p-3 flex items-center gap-2 shrink-0 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        {!isListening ? (
          <Button
            className="flex-1 h-14"
            onClick={startListening}
            disabled={micDisabled}
          >
            <Mic className="mr-2 h-5 w-5" />
            {isAiSpeaking ? 'AI가 말하는 중...' : '말하기'}
          </Button>
        ) : (
          <Button
            className="flex-1 h-14"
            variant="destructive"
            onClick={handleSend}
          >
            <StopCircle className="mr-2 h-5 w-5" /> 완료
          </Button>
        )}
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
