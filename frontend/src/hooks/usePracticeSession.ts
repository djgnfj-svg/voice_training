'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useTextToSpeech } from './useTextToSpeech';
import { useAudioRecorder } from './useAudioRecorder';
import { normalizeTranscript } from '@/lib/transcript';
import { transcribeWithWhisper } from '@/lib/whisper-client';
import type { AnswerEvaluation, InterviewType } from '@/types';

type PracticePhase = 'loading' | 'select' | 'reviewing' | 'practicing' | 'comparing' | 'summary';

interface PracticeAnswer {
  questionIndex: number;
  questionText: string;
  questionSource: string;
  answerTranscript: string | null;
  modelAnswer: string | null;
  overallScore: number | null;
  briefFeedback: string | null;
}

interface PracticeResult {
  questionIndex: number;
  practiceTranscript: string;
  evaluation: AnswerEvaluation | null;
  isEvaluating: boolean;
}

interface PracticeData {
  sessionId: string;
  type: InterviewType;
  categories: string[];
  difficulty: string;
  answers: PracticeAnswer[];
}

export function usePracticeSession(sessionId: string) {
  const [phase, setPhase] = useState<PracticePhase>('loading');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [results, setResults] = useState<PracticeResult[]>([]);
  const answerStartTimeRef = useRef<number>(0);

  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const recorder = useAudioRecorder();

  const { data, isLoading, error } = useQuery<PracticeData>({
    queryKey: ['practice', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/interview/${sessionId}/practice`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '데이터 로딩 실패');
      }
      return res.json();
    },
  });

  // Transition to select once data loaded
  useEffect(() => {
    if (data && phase === 'loading' && !isLoading) {
      setPhase('select');
    }
  }, [data, phase, isLoading]);

  const answers = data?.answers ?? [];
  const currentAnswer = answers[currentIndex] ?? null;
  const currentResult = results.find(r => r.questionIndex === currentIndex) ?? null;
  const totalQuestions = answers.length;

  const startPractice = useCallback(async () => {
    if (!currentAnswer) return;
    setPhase('practicing');
    speech.resetTranscript();

    await tts.speak(currentAnswer.questionText);
    answerStartTimeRef.current = Date.now();
    speech.startListening();
    recorder.startRecording();
  }, [currentAnswer, tts, speech, recorder]);

  const submitPractice = useCallback(async () => {
    speech.stopListening();
    const audioBlob = await recorder.stopRecording();
    const webSpeechTranscript = normalizeTranscript(speech.transcript);

    // Whisper 하이브리드
    let transcript = webSpeechTranscript;
    if (audioBlob && audioBlob.size > 0) {
      const whisperResult = await transcribeWithWhisper(audioBlob);
      if (whisperResult) {
        transcript = whisperResult;
      }
    }

    setResults(prev => [
      ...prev.filter(r => r.questionIndex !== currentIndex),
      {
        questionIndex: currentIndex,
        practiceTranscript: transcript,
        evaluation: null,
        isEvaluating: false,
      },
    ]);
    setPhase('comparing');
  }, [speech, recorder, currentIndex]);

  const requestEvaluation = useCallback(async () => {
    if (!data || !currentAnswer) return;
    const result = results.find(r => r.questionIndex === currentIndex);
    if (!result || result.isEvaluating || result.evaluation) return;

    setResults(prev =>
      prev.map(r =>
        r.questionIndex === currentIndex ? { ...r, isEvaluating: true } : r
      )
    );

    try {
      const res = await fetch('/api/interview/practice-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionText: currentAnswer.questionText,
          answerTranscript: result.practiceTranscript,
          interviewType: data.type,
        }),
      });

      if (!res.ok) throw new Error('평가 실패');
      const evaluation: AnswerEvaluation = await res.json();

      setResults(prev =>
        prev.map(r =>
          r.questionIndex === currentIndex
            ? { ...r, evaluation, isEvaluating: false }
            : r
        )
      );
    } catch {
      setResults(prev =>
        prev.map(r =>
          r.questionIndex === currentIndex ? { ...r, isEvaluating: false } : r
        )
      );
    }
  }, [data, currentAnswer, currentIndex, results]);

  const nextQuestion = useCallback(() => {
    const nextIdx = currentIndex + 1;
    if (nextIdx >= totalQuestions) {
      setPhase('summary');
      return;
    }
    setCurrentIndex(nextIdx);
    setPhase('reviewing');
  }, [currentIndex, totalQuestions]);

  const goToQuestion = useCallback((index: number) => {
    if (index < 0 || index >= totalQuestions) return;
    setCurrentIndex(index);
    const hasResult = results.some(r => r.questionIndex === index);
    setPhase(hasResult ? 'comparing' : 'reviewing');
  }, [totalQuestions, results]);

  const startAll = useCallback(() => {
    setCurrentIndex(0);
    setPhase('reviewing');
  }, []);

  const showModelAnswer = useCallback(() => {
    setPhase('comparing');
  }, []);

  const goToSummary = useCallback(() => {
    setPhase('summary');
  }, []);

  const goToSelect = useCallback(() => {
    setPhase('select');
  }, []);

  return {
    phase,
    data,
    isLoading,
    error,
    currentIndex,
    currentAnswer,
    currentResult,
    results,
    totalQuestions,
    speech,
    tts,
    startPractice,
    submitPractice,
    requestEvaluation,
    nextQuestion,
    goToQuestion,
    startAll,
    showModelAnswer,
    goToSummary,
    goToSelect,
    progress: totalQuestions ? ((currentIndex + 1) / totalQuestions) * 100 : 0,
  };
}
