'use client';

import { useCallback, useRef, useState } from 'react';
import {
  startLearningSession,
  respondToLearning,
  endLearningSession,
} from '@/lib/learning-agent-api';

export type LearningPhase =
  | 'idle'
  | 'connecting'
  | 'tutor-speaking'
  | 'user-speaking'
  | 'processing'
  | 'credit-confirm'
  | 'completing'
  | 'summary'
  | 'error';

export interface LearningMessage {
  role: 'tutor' | 'user';
  content: string;
  phase?: string;
}

export interface LearningSummary {
  topicCovered?: string;
  keyPoints?: string[];
  strengths?: string[];
  weaknesses?: string[];
  nextTopicSuggestion?: string;
  encouragement?: string;
}

export function useLearningAgent() {
  const [phase, setPhase] = useState<LearningPhase>('idle');
  const [messages, setMessages] = useState<LearningMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isFreeSession, setIsFreeSession] = useState(false);
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<ReturnType<typeof startLearningSession> | null>(null);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const attachListeners = useCallback(
    (source: ReturnType<typeof startLearningSession>) => {
      sourceRef.current = source;

      source.addEventListener('session', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setSessionId(data.sessionId);
        setIsFreeSession(!!data.isFree);
      });

      source.addEventListener('status', () => {
        // internal processing indicator only — no phase change
      });

      source.addEventListener('tutor', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          { role: 'tutor', content: data.message, phase: data.phase },
        ]);
        setPhase('tutor-speaking');
      });

      source.addEventListener('credit_prompt', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          { role: 'tutor', content: data.message, phase: 'credit_prompt' },
        ]);
        setPhase('credit-confirm');
      });

      source.addEventListener('complete', (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setSummary(data.summary);
        setPhase('summary');
        cleanup();
      });

      source.addEventListener('error', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setError(data.error || '오류가 발생했습니다');
        } catch {
          setError('연결이 끊어졌습니다');
        }
        setPhase('error');
        cleanup();
      });
    },
    [cleanup],
  );

  const start = useCallback(() => {
    cleanup();
    setMessages([]);
    setSummary(null);
    setError(null);
    setSessionId(null);
    setIsFreeSession(false);
    setPhase('connecting');

    const source = startLearningSession();
    attachListeners(source);
  }, [cleanup, attachListeners]);

  const submitAnswer = useCallback(
    (answer: string, creditConfirmed?: boolean) => {
      if (!sessionId) return;
      cleanup();

      setMessages((prev) => [...prev, { role: 'user', content: answer }]);
      setPhase('processing');

      const source = respondToLearning({
        sessionId,
        answer,
        creditConfirmed,
      });
      attachListeners(source);
    },
    [sessionId, cleanup, attachListeners],
  );

  const confirmCredit = useCallback(() => {
    submitAnswer('계속할게요', true);
  }, [submitAnswer]);

  const declineCredit = useCallback(() => {
    if (!sessionId) return;
    cleanup();
    setPhase('completing');

    const source = endLearningSession(sessionId);
    attachListeners(source);
  }, [sessionId, cleanup, attachListeners]);

  const endEarly = useCallback(() => {
    if (!sessionId) return;
    cleanup();
    setPhase('completing');

    const source = endLearningSession(sessionId);
    attachListeners(source);
  }, [sessionId, cleanup, attachListeners]);

  return {
    phase,
    messages,
    sessionId,
    isFreeSession,
    summary,
    error,
    setPhase,
    start,
    submitAnswer,
    confirmCredit,
    declineCredit,
    endEarly,
  };
}
