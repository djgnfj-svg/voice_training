'use client';

import { useState, useCallback, useRef } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useTextToSpeech } from './useTextToSpeech';
import type { InterviewQuestion, AnswerEvaluation } from '@/types';

type SessionPhase = 'idle' | 'asking' | 'listening' | 'evaluating' | 'feedback' | 'completed';

interface InterviewSessionState {
  phase: SessionPhase;
  sessionId: string | null;
  questions: InterviewQuestion[];
  currentQuestionIndex: number;
  answers: AnswerWithEval[];
  startTime: number | null;
}

interface AnswerWithEval {
  questionIndex: number;
  transcript: string;
  evaluation: AnswerEvaluation | null;
  responseTimeSec: number;
}

export function useInterviewSession() {
  const [state, setState] = useState<InterviewSessionState>({
    phase: 'idle',
    sessionId: null,
    questions: [],
    currentQuestionIndex: 0,
    answers: [],
    startTime: null,
  });

  const answerStartTimeRef = useRef<number>(0);
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();

  const startSession = useCallback(
    async (sessionId: string, questions: InterviewQuestion[]) => {
      setState({
        phase: 'asking',
        sessionId,
        questions,
        currentQuestionIndex: 0,
        answers: [],
        startTime: Date.now(),
      });

      // Speak the first question
      if (questions.length > 0) {
        await tts.speak(questions[0].text);
        answerStartTimeRef.current = Date.now();
        setState((prev) => ({ ...prev, phase: 'listening' }));
        speech.resetTranscript();
        speech.startListening();
      }
    },
    [tts, speech]
  );

  const submitAnswer = useCallback(async () => {
    if (!state.sessionId) return;

    speech.stopListening();
    const responseTimeSec = Math.round((Date.now() - answerStartTimeRef.current) / 1000);
    const transcript = speech.transcript;

    setState((prev) => ({ ...prev, phase: 'evaluating' }));

    try {
      const res = await fetch('/api/interview/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          questionIndex: state.currentQuestionIndex,
          answerTranscript: transcript,
          responseTimeSec,
        }),
      });

      if (!res.ok) throw new Error('Evaluation failed');

      const evaluation: AnswerEvaluation = await res.json();

      const newAnswer: AnswerWithEval = {
        questionIndex: state.currentQuestionIndex,
        transcript,
        evaluation,
        responseTimeSec,
      };

      setState((prev) => ({
        ...prev,
        phase: 'feedback',
        answers: [...prev.answers, newAnswer],
      }));
    } catch (error) {
      console.error('Evaluation error:', error);
      setState((prev) => ({
        ...prev,
        phase: 'feedback',
        answers: [
          ...prev.answers,
          {
            questionIndex: prev.currentQuestionIndex,
            transcript,
            evaluation: null,
            responseTimeSec,
          },
        ],
      }));
    }
  }, [state.sessionId, state.currentQuestionIndex, speech]);

  const nextQuestion = useCallback(async () => {
    const nextIndex = state.currentQuestionIndex + 1;

    if (nextIndex >= state.questions.length) {
      setState((prev) => ({ ...prev, phase: 'completed' }));

      // Complete the session
      if (state.sessionId) {
        await fetch(`/api/interview/${state.sessionId}/complete`, {
          method: 'POST',
        });
      }
      return;
    }

    setState((prev) => ({
      ...prev,
      currentQuestionIndex: nextIndex,
      phase: 'asking',
    }));

    // Speak next question
    await tts.speak(state.questions[nextIndex].text);
    answerStartTimeRef.current = Date.now();
    setState((prev) => ({ ...prev, phase: 'listening' }));
    speech.resetTranscript();
    speech.startListening();
  }, [state.currentQuestionIndex, state.questions, state.sessionId, tts, speech]);

  const skipQuestion = useCallback(async () => {
    speech.stopListening();

    const newAnswer: AnswerWithEval = {
      questionIndex: state.currentQuestionIndex,
      transcript: '(건너뜀)',
      evaluation: null,
      responseTimeSec: 0,
    };

    setState((prev) => ({
      ...prev,
      answers: [...prev.answers, newAnswer],
    }));

    await nextQuestion();
  }, [state.currentQuestionIndex, speech, nextQuestion]);

  return {
    ...state,
    speech,
    tts,
    startSession,
    submitAnswer,
    nextQuestion,
    skipQuestion,
    currentQuestion: state.questions[state.currentQuestionIndex] || null,
    totalQuestions: state.questions.length,
    progress: state.questions.length
      ? ((state.currentQuestionIndex + 1) / state.questions.length) * 100
      : 0,
  };
}
