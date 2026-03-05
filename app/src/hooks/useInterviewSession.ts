'use client';

import { useState, useCallback, useRef } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useTextToSpeech } from './useTextToSpeech';
import { useAudioRecorder } from './useAudioRecorder';
import { normalizeTranscript } from '@/lib/transcript';
import type { InterviewQuestion, AnswerEvaluation, InterviewType } from '@/types';

const MAX_AUDIO_SIZE = 4.5 * 1024 * 1024; // 4.5MB
const MAX_FOLLOWUP_ROUNDS = 2;

function uploadAudioFireAndForget(sessionId: string, questionIndex: number, audioBlob: Blob) {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('sessionId', sessionId);
  formData.append('questionIndex', String(questionIndex));
  fetch('/api/interview/audio', { method: 'POST', body: formData }).catch(() => {});
}

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
  systemDesign: boolean;
  isFollowUp: boolean;
  followUpRound: number;
  followUpEvaluations: AnswerEvaluation[];
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
    systemDesign: false,
    isFollowUp: false,
    followUpRound: 0,
    followUpEvaluations: [],
  });

  const answerStartTimeRef = useRef<number>(0);
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const recorder = useAudioRecorder();

  const startSession = useCallback(
    async (sessionId: string, questions: InterviewQuestion[], interviewType?: InterviewType, deepMode?: boolean, systemDesign?: boolean) => {
      setState({
        phase: 'asking',
        sessionId,
        questions,
        currentQuestionIndex: 0,
        answers: [],
        startTime: Date.now(),
        interviewType: interviewType || null,
        deepMode: deepMode || false,
        systemDesign: systemDesign || false,
        isFollowUp: false,
        followUpRound: 0,
        followUpEvaluations: [],
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

  const resumeSession = useCallback(
    async (
      sessionId: string,
      questions: InterviewQuestion[],
      previousAnswers: AnswerWithEval[],
      resumeFromIndex: number,
      interviewType?: InterviewType,
      deepMode?: boolean,
      systemDesign?: boolean
    ) => {
      // All questions already answered → complete immediately
      if (resumeFromIndex >= questions.length) {
        setState({
          phase: 'completed',
          sessionId,
          questions,
          currentQuestionIndex: questions.length - 1,
          answers: previousAnswers,
          startTime: Date.now(),
          interviewType: interviewType || null,
          deepMode: deepMode || false,
          systemDesign: systemDesign || false,
          isFollowUp: false,
          followUpRound: 0,
          followUpEvaluations: [],
        });
        await fetch(`/api/interview/${sessionId}/complete`, { method: 'POST' });
        return;
      }

      setState({
        phase: 'asking',
        sessionId,
        questions,
        currentQuestionIndex: resumeFromIndex,
        answers: previousAnswers,
        startTime: Date.now(),
        interviewType: interviewType || null,
        deepMode: deepMode || false,
        systemDesign: systemDesign || false,
        isFollowUp: false,
        followUpRound: 0,
        followUpEvaluations: [],
      });

      await tts.speak(questions[resumeFromIndex].text);
      answerStartTimeRef.current = Date.now();
      setState((prev) => ({ ...prev, phase: 'listening' }));
      speech.resetTranscript();
      speech.startListening();
      recorder.startRecording();
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

    // Fire-and-forget audio upload
    if (audioBlob && audioBlob.size > 0 && state.sessionId) {
      uploadAudioFireAndForget(state.sessionId, state.currentQuestionIndex, audioBlob);
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
          ...(state.systemDesign ? { systemDesign: true } : {}),
          ...((state.deepMode || state.systemDesign) && currentQ?.relatedKeyPoints ? { relatedKeyPoints: currentQ.relatedKeyPoints } : {}),
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
      followUpRound: 0,
      followUpEvaluations: [],
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
    const currentRound = state.followUpRound;

    // Determine which followUpQuestion to use
    let followUpQuestion: string | undefined;
    if (currentRound === 0) {
      // First follow-up: use the main answer's evaluation
      const currentAnswer = state.answers.find(
        (a) => a.questionIndex === state.currentQuestionIndex
      );
      followUpQuestion = currentAnswer?.evaluation?.followUpQuestion ?? undefined;
    } else {
      // Subsequent follow-ups: use the latest follow-up evaluation's followUpQuestion
      const lastFollowUpEval = state.followUpEvaluations[state.followUpEvaluations.length - 1];
      followUpQuestion = lastFollowUpEval?.followUpQuestion ?? undefined;
    }

    if (!followUpQuestion) return;

    setState((prev) => ({
      ...prev,
      isFollowUp: true,
      followUpRound: currentRound + 1,
      phase: 'asking',
    }));

    await tts.speak(followUpQuestion);
    answerStartTimeRef.current = Date.now();
    setState((prev) => ({ ...prev, phase: 'listening' }));
    speech.resetTranscript();
    speech.startListening();
    recorder.startRecording();
  }, [state.answers, state.currentQuestionIndex, state.followUpRound, state.followUpEvaluations, tts, speech, recorder]);

  const submitFollowUpAnswer = useCallback(async () => {
    // Determine the current follow-up question text
    let followUpQuestion: string | undefined;
    if (state.followUpRound === 1) {
      const currentAnswer = state.answers.find(
        (a) => a.questionIndex === state.currentQuestionIndex
      );
      followUpQuestion = currentAnswer?.evaluation?.followUpQuestion ?? undefined;
    } else {
      const lastFollowUpEval = state.followUpEvaluations[state.followUpEvaluations.length - 1];
      followUpQuestion = lastFollowUpEval?.followUpQuestion ?? undefined;
    }
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
    const currentAnswer = state.answers.find(
      (a) => a.questionIndex === state.currentQuestionIndex
    );

    // Build previousContext for multi-round follow-up
    const followUpHistory: { question: string; answer: string }[] = [];
    if (state.followUpEvaluations.length > 0) {
      // Add previous follow-up rounds
      for (let i = 0; i < state.followUpEvaluations.length; i++) {
        const prevEval = state.followUpEvaluations[i];
        // The question for round i+1 was the followUpQuestion from the previous evaluation
        const prevQuestion = i === 0
          ? currentAnswer?.evaluation?.followUpQuestion
          : state.followUpEvaluations[i - 1]?.followUpQuestion;
        if (prevQuestion) {
          followUpHistory.push({
            question: prevQuestion,
            answer: prevEval.correctedTranscript || '(답변)',
          });
        }
      }
    }

    const previousContext = {
      originalQuestion: currentQ?.text || '',
      originalAnswer: currentAnswer?.transcript || '',
      followUpHistory,
    };

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
          previousContext,
        }),
      });

      if (!res.ok) throw new Error('Follow-up evaluation failed');

      const evaluation: AnswerEvaluation = await res.json();

      setState((prev) => ({
        ...prev,
        phase: 'feedback',
        followUpEvaluations: [...prev.followUpEvaluations, evaluation],
      }));
    } catch (error) {
      console.error('Follow-up evaluation error:', error);
      setState((prev) => ({
        ...prev,
        phase: 'feedback',
      }));
    }
  }, [state.answers, state.currentQuestionIndex, state.interviewType, state.deepMode, state.questions, state.followUpRound, state.followUpEvaluations, speech, recorder]);

  // Determine if more follow-ups are available
  const latestFollowUpEval = state.followUpEvaluations.length > 0
    ? state.followUpEvaluations[state.followUpEvaluations.length - 1]
    : null;
  const canDoMoreFollowUp = state.followUpRound < MAX_FOLLOWUP_ROUNDS &&
    latestFollowUpEval?.followUpQuestion != null;

  return {
    ...state,
    speech,
    tts,
    startSession,
    resumeSession,
    submitAnswer,
    nextQuestion,
    skipQuestion,
    startFollowUp,
    submitFollowUpAnswer,
    canDoMoreFollowUp,
    currentQuestion: state.questions[state.currentQuestionIndex] || null,
    totalQuestions: state.questions.length,
    progress: state.questions.length
      ? ((state.currentQuestionIndex + 1) / state.questions.length) * 100
      : 0,
  };
}
