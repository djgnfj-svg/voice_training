'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

export interface ModelAnswerQuestion {
  text: string;
  source: string;
  category: string;
  difficulty: string;
  modelAnswer: string;
  answerTips: string[];
  keyPoints: string[];
}

export interface InterviewPlan {
  type: string;
  categories: string[];
  difficulty: string;
  totalQuestions: number;
  reasoning: string;
}

export type StudyPhase = 'loading' | 'studying' | 'error';

export function useModelAnswerStudy(resumeId: string) {
  const [phase, setPhase] = useState<StudyPhase>('loading');
  const [plan, setPlan] = useState<InterviewPlan | null>(null);
  const [questions, setQuestions] = useState<ModelAnswerQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [revealedAnswers, setRevealedAnswers] = useState<Set<number>>(new Set());
  const [userNotes, setUserNotes] = useState<Map<number, string>>(new Map());
  const [errorMessage, setErrorMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      abortRef.current = new AbortController();

      try {
        const jobPostingText = sessionStorage.getItem('model_answer_job_posting');

        const res = await fetch('/api/model-answer/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resumeId,
            jobPostingText: jobPostingText || undefined,
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || '생성에 실패했습니다');
        }

        const data = await res.json();
        setPlan(data.plan);
        setQuestions(data.questions);
        setPhase('studying');
      } catch (error: any) {
        if (error.name === 'AbortError') return;
        console.error('Model answer fetch error:', error);
        setErrorMessage(error.message || '모범답안 생성 중 오류가 발생했습니다');
        setPhase('error');
      }
    };

    fetchData();

    return () => {
      abortRef.current?.abort();
    };
  }, [resumeId]);

  const goToQuestion = useCallback(
    (index: number) => {
      if (index >= 0 && index < questions.length) {
        setCurrentIndex(index);
      }
    },
    [questions.length]
  );

  const nextQuestion = useCallback(() => {
    goToQuestion(currentIndex + 1);
  }, [currentIndex, goToQuestion]);

  const prevQuestion = useCallback(() => {
    goToQuestion(currentIndex - 1);
  }, [currentIndex, goToQuestion]);

  const toggleReveal = useCallback((index: number) => {
    setRevealedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const revealAll = useCallback(() => {
    setRevealedAnswers(new Set(questions.map((_, i) => i)));
  }, [questions]);

  const setNote = useCallback((index: number, text: string) => {
    setUserNotes((prev) => {
      const next = new Map(prev);
      next.set(index, text);
      return next;
    });
  }, []);

  return {
    phase,
    plan,
    questions,
    currentIndex,
    revealedAnswers,
    userNotes,
    errorMessage,
    goToQuestion,
    nextQuestion,
    prevQuestion,
    toggleReveal,
    revealAll,
    setNote,
  };
}
