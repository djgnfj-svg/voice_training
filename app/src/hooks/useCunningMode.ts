'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { normalizeTranscript } from '@/lib/transcript';

export interface CunningQA {
  question: string;
  answer: string;
  isStreaming: boolean;
}

export type CunningPhase = 'idle' | 'listening' | 'generating';

interface UseCunningModeParams {
  resumeId: string;
  jobPostingText?: string;
  silenceDelay?: number;
  cunningSessionId?: string;
}

export function useCunningMode({
  resumeId,
  jobPostingText,
  silenceDelay = 2000,
  cunningSessionId,
}: UseCunningModeParams) {
  const speech = useSpeechRecognition();
  const [phase, setPhase] = useState<CunningPhase>('idle');
  const [qaHistory, setQaHistory] = useState<CunningQA[]>([]);
  const [isPaused, setIsPaused] = useState(false);

  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTranscriptRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const fetchSuggestion = useCallback(
    async (question: string) => {
      setPhase('generating');

      const newQA: CunningQA = { question, answer: '', isStreaming: true };
      setQaHistory((prev) => [...prev, newQA]);
      const qaIndex = qaHistory.length;

      abortRef.current = new AbortController();

      try {
        const historyForApi = qaHistory.slice(-3).map((qa) => ({
          question: qa.question,
          answer: qa.answer,
        }));

        const res = await fetch('/api/cunning/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resumeId,
            question,
            jobPostingText: jobPostingText || undefined,
            conversationHistory: historyForApi.length > 0 ? historyForApi : undefined,
            cunningSessionId: cunningSessionId || undefined,
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          throw new Error('API 요청 실패');
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('스트림 읽기 실패');

        const decoder = new TextDecoder();
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.text) {
                accumulated += parsed.text;
                setQaHistory((prev) => {
                  const updated = [...prev];
                  const idx = updated.length - 1;
                  if (idx >= 0) {
                    updated[idx] = { ...updated[idx], answer: accumulated };
                  }
                  return updated;
                });
              }
            } catch {
              // skip malformed JSON
            }
          }
        }

        setQaHistory((prev) => {
          const updated = [...prev];
          const idx = updated.length - 1;
          if (idx >= 0) {
            updated[idx] = { ...updated[idx], isStreaming: false };
          }
          return updated;
        });
      } catch (error: any) {
        if (error.name === 'AbortError') return;
        console.error('Cunning suggest error:', error);
        setQaHistory((prev) => {
          const updated = [...prev];
          const idx = updated.length - 1;
          if (idx >= 0) {
            updated[idx] = {
              ...updated[idx],
              answer: updated[idx].answer || '답변 생성에 실패했습니다.',
              isStreaming: false,
            };
          }
          return updated;
        });
      } finally {
        abortRef.current = null;
        setPhase('listening');
      }
    },
    [resumeId, jobPostingText, qaHistory, cunningSessionId]
  );

  const submitQuestion = useCallback(
    (text?: string) => {
      const question = normalizeTranscript(text || speech.transcript);
      if (question.length < 10) return;

      clearSilenceTimer();
      speech.resetTranscript();
      prevTranscriptRef.current = '';
      fetchSuggestion(question);
    },
    [speech, clearSilenceTimer, fetchSuggestion]
  );

  // Silence detection: monitor transcript changes
  useEffect(() => {
    if (phase !== 'listening' || isPaused) return;

    const currentTranscript = speech.transcript;
    if (currentTranscript === prevTranscriptRef.current) return;

    prevTranscriptRef.current = currentTranscript;
    clearSilenceTimer();

    if (currentTranscript.trim().length >= 10 && !speech.interimTranscript) {
      silenceTimerRef.current = setTimeout(() => {
        submitQuestion(currentTranscript);
      }, silenceDelay);
    }
  }, [
    speech.transcript,
    speech.interimTranscript,
    phase,
    isPaused,
    silenceDelay,
    clearSilenceTimer,
    submitQuestion,
  ]);

  const start = useCallback(() => {
    speech.resetTranscript();
    prevTranscriptRef.current = '';
    setQaHistory([]);
    setPhase('listening');
    setIsPaused(false);
    speech.startListening();
  }, [speech]);

  const stop = useCallback(() => {
    clearSilenceTimer();
    speech.stopListening();
    setPhase('idle');
    setIsPaused(false);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [speech, clearSilenceTimer]);

  const pause = useCallback(() => {
    clearSilenceTimer();
    speech.stopListening();
    setIsPaused(true);
  }, [speech, clearSilenceTimer]);

  const resume = useCallback(() => {
    setIsPaused(false);
    speech.startListening();
  }, [speech]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSilenceTimer();
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [clearSilenceTimer]);

  return {
    phase,
    qaHistory,
    isPaused,
    isSupported: speech.isSupported,
    transcript: speech.transcript,
    interimTranscript: speech.interimTranscript,
    start,
    stop,
    pause,
    resume,
    submitQuestion,
  };
}
