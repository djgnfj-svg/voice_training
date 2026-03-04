'use client';

import { useState, useCallback, useRef } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useTextToSpeech } from './useTextToSpeech';
import { useAudioRecorder } from './useAudioRecorder';
import { normalizeTranscript } from '@/lib/transcript';
import type { InterviewQuestion, AnswerEvaluation, InterviewType } from '@/types';

const MAX_AUDIO_SIZE = 4.5 * 1024 * 1024; // 4.5MB

async function transcribeWithWhisper(audioBlob: Blob): Promise<string | null> {
  if (audioBlob.size > MAX_AUDIO_SIZE) return null;
  try {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!res.ok) return null;
    const data = await res.json();
    return data.transcript || null;
  } catch {
    return null;
  }
}

type SessionPhase = 'idle' | 'asking' | 'listening' | 'evaluating' | 'feedback' | 'completed';

interface InterviewSessionState {
  phase: SessionPhase;
  sessionId: string | null;
  questions: InterviewQuestion[];
  currentQuestionIndex: number;
  answers: AnswerWithEval[];
  startTime: number | null;
  interviewType: InterviewType | null;
  deepMode: boolean;
  isFollowUp: boolean;
  followUpEvaluation: AnswerEvaluation | null;
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
    interviewType: null,
    deepMode: false,
    isFollowUp: false,
    followUpEvaluation: null,
  });

  const answerStartTimeRef = useRef<number>(0);
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const recorder = useAudioRecorder();

  const startSession = useCallback(
    async (sessionId: string, questions: InterviewQuestion[], interviewType?: InterviewType, deepMode?: boolean) => {
      setState({
        phase: 'asking',
        sessionId,
        questions,
        currentQuestionIndex: 0,
        answers: [],
        startTime: Date.now(),
        interviewType: interviewType || null,
        deepMode: deepMode || false,
        isFollowUp: false,
        followUpEvaluation: null,
      });

      // Speak the first question
      if (questions.length > 0) {
        await tts.speak(questions[0].text);
        answerStartTimeRef.current = Date.now();
        setState((prev) => ({ ...prev, phase: 'listening' }));
        speech.resetTranscript();
        speech.startListening();
        recorder.startRecording();
      }
    },
    [tts, speech, recorder]
  );

  const submitAnswer = useCallback(async () => {
    if (!state.sessionId) return;

    speech.stopListening();
    const audioBlob = recorder.stopRecording();
    const responseTimeSec = Math.round((Date.now() - answerStartTimeRef.current) / 1000);
    const webSpeechTranscript = normalizeTranscript(speech.transcript);

    setState((prev) => ({ ...prev, phase: 'evaluating' }));

    // Whisper 하이브리드: 녹음 데이터가 있으면 Whisper 시도, 실패 시 Web Speech API 폴백
    let transcript = webSpeechTranscript;
    if (audioBlob && audioBlob.size > 0) {
      const whisperResult = await transcribeWithWhisper(audioBlob);
      if (whisperResult) {
        transcript = whisperResult;
      }
    }

    const currentQ = state.questions[state.currentQuestionIndex];

    try {
      const res = await fetch('/api/interview/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          questionIndex: state.currentQuestionIndex,
          answerTranscript: transcript,
          responseTimeSec,
          ...(state.deepMode ? { deepMode: true } : {}),
          ...(state.deepMode && currentQ?.relatedKeyPoints ? { relatedKeyPoints: currentQ.relatedKeyPoints } : {}),
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
  }, [state.sessionId, state.currentQuestionIndex, state.deepMode, state.questions, speech, recorder]);

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
      isFollowUp: false,
      followUpEvaluation: null,
    }));

    // Speak next question
    await tts.speak(state.questions[nextIndex].text);
    answerStartTimeRef.current = Date.now();
    setState((prev) => ({ ...prev, phase: 'listening' }));
    speech.resetTranscript();
    speech.startListening();
    recorder.startRecording();
  }, [state.currentQuestionIndex, state.questions, state.sessionId, tts, speech, recorder]);

  const skipQuestion = useCallback(async () => {
    speech.stopListening();
    recorder.resetRecording();

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
  }, [state.currentQuestionIndex, speech, recorder, nextQuestion]);

  const startFollowUp = useCallback(async () => {
    const currentAnswer = state.answers.find(
      (a) => a.questionIndex === state.currentQuestionIndex
    );
    const followUpQuestion = currentAnswer?.evaluation?.followUpQuestion;
    if (!followUpQuestion) return;

    setState((prev) => ({
      ...prev,
      isFollowUp: true,
      followUpEvaluation: null,
      phase: 'asking',
    }));

    await tts.speak(followUpQuestion);
    answerStartTimeRef.current = Date.now();
    setState((prev) => ({ ...prev, phase: 'listening' }));
    speech.resetTranscript();
    speech.startListening();
    recorder.startRecording();
  }, [state.answers, state.currentQuestionIndex, tts, speech, recorder]);

  const submitFollowUpAnswer = useCallback(async () => {
    const currentAnswer = state.answers.find(
      (a) => a.questionIndex === state.currentQuestionIndex
    );
    const followUpQuestion = currentAnswer?.evaluation?.followUpQuestion;
    if (!followUpQuestion) return;

    speech.stopListening();
    const audioBlob = recorder.stopRecording();
    const webSpeechTranscript = normalizeTranscript(speech.transcript);

    setState((prev) => ({ ...prev, phase: 'evaluating' }));

    // Whisper 하이브리드
    let transcript = webSpeechTranscript;
    if (audioBlob && audioBlob.size > 0) {
      const whisperResult = await transcribeWithWhisper(audioBlob);
      if (whisperResult) {
        transcript = whisperResult;
      }
    }

    const currentQ = state.questions[state.currentQuestionIndex];

    try {
      const res = await fetch('/api/interview/practice-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionText: followUpQuestion,
          answerTranscript: transcript,
          interviewType: state.interviewType || 'MIXED',
          ...(state.deepMode ? { deepMode: true } : {}),
          ...(state.deepMode && currentQ?.relatedKeyPoints ? { relatedKeyPoints: currentQ.relatedKeyPoints } : {}),
        }),
      });

      if (!res.ok) throw new Error('Follow-up evaluation failed');

      const evaluation: AnswerEvaluation = await res.json();

      setState((prev) => ({
        ...prev,
        phase: 'feedback',
        followUpEvaluation: evaluation,
      }));
    } catch (error) {
      console.error('Follow-up evaluation error:', error);
      setState((prev) => ({
        ...prev,
        phase: 'feedback',
        followUpEvaluation: null,
      }));
    }
  }, [state.answers, state.currentQuestionIndex, state.interviewType, state.deepMode, state.questions, speech, recorder]);

  return {
    ...state,
    speech,
    tts,
    startSession,
    submitAnswer,
    nextQuestion,
    skipQuestion,
    startFollowUp,
    submitFollowUpAnswer,
    currentQuestion: state.questions[state.currentQuestionIndex] || null,
    totalQuestions: state.questions.length,
    progress: state.questions.length
      ? ((state.currentQuestionIndex + 1) / state.questions.length) * 100
      : 0,
  };
}
