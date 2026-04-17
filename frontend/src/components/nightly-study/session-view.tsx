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
  const bottomRef = useRef<HTMLDivElement>(null);

  const { isListening, startListening, stopListening, transcript, resetTranscript } = useSpeechRecognition();

  const { isStreaming, sendTurn } = useNightlyStudyStream({
    sessionId,
    onText: (text) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: text }]);
      playTTS(text);
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

  useEffect(() => {
    playTTS(firstMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = async () => {
    const text = transcript.trim();
    if (!text || isStreaming) return;
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    resetTranscript();
    stopListening();
    await sendTurn(text);
  };

  return (
    <div className="flex flex-col h-[100dvh]">
      <header className="flex items-center justify-between border-b p-3">
        {currentTopicLabel ? (
          <Badge variant="secondary">{currentTopicLabel}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">대화 중</span>
        )}
        <Button variant="ghost" size="sm" onClick={onEnd}>
          <X className="h-4 w-4 mr-1" /> 종료
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
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
        <div className="bg-amber-50 border-t border-amber-200 p-2 text-xs text-center text-amber-900">
          AI가 오늘 여기까지 정리하자고 제안했어요
        </div>
      ) : null}

      <footer className="border-t p-3 flex items-center gap-2">
        {!isListening ? (
          <Button
            className="flex-1 h-14"
            onClick={startListening}
            disabled={isStreaming}
          >
            <Mic className="mr-2 h-5 w-5" /> 말하기
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

async function playTTS(text: string) {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, persona: 'tutor' }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    await audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
  } catch {
    // fail silently
  }
}
