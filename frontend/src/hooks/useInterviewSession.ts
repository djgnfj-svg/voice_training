'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useTextToSpeech } from './useTextToSpeech';
import { useAudioRecorder } from './useAudioRecorder';
import { useSpeechAnalytics, type SpeechMetrics } from './useSpeechAnalytics';
import { normalizeTranscript } from '@/lib/transcript';
import { transcribeWithWhisper } from '@/lib/whisper-client';
import type { InterviewQuestion, AnswerEvaluation, InterviewType } from '@/types';

const MAX_FOLLOWUP_ROUNDS = 2;

function uploadAudioFireAndForget(sessionId: string, questionIndex: number, audioBlob: Blob) {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('sessionId', sessionId);
  formData.append('questionIndex', String(questionIndex));
  fetch('/api/interview/audio', { method: 'POST', body: formData }).catch(() => {});
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
  textMode: boolean;
  textInput: string;
  isFollowUp: boolean;
  followUpRound: number;
  followUpEvaluations: AnswerEvaluation[];
}

interface AnswerWithEval {
  questionIndex: number;
  transcript: string;
  evaluation: AnswerEvaluation | null;
  responseTimeSec: number;
  speechMetrics?: SpeechMetrics;
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
    textMode: false,
    textInput: '',
    isFollowUp: false,
    followUpRound: 0,
    followUpEvaluations: [],
  });

  const answerStartTimeRef = useRef<number>(0);
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const recorder = useAudioRecorder();
  const analytics = useSpeechAnalytics();

  const startSession = useCallback(
    async (sessionId: string, questions: InterviewQuestion[], interviewType?: InterviewType, deepMode?: boolean, textMode?: boolean) => {
      setState({
        phase: 'asking',
        sessionId,
        questions,
        currentQuestionIndex: 0,
        answers: [],
        startTime: Date.now(),
        interviewType: interviewType || null,
        deepMode: deepMode || false,
        textMode: textMode || false,
        textInput: '',
        isFollowUp: false,
        followUpRound: 0,
        followUpEvaluations: [],
      });

      // Speak the first question (skip TTS in text mode)
      if (questions.length > 0) {
        if (!textMode) {
          await tts.speak(questions[0].text);
        }
        answerStartTimeRef.current = Date.now();
        setState((prev) => ({ ...prev, phase: 'listening' }));
        if (!textMode) {
          speech.resetTranscript();
          speech.startListening();
          recorder.startRecording();
          analytics.start('');
        }
      }
    },
    [tts, speech, recorder, analytics]
  );

  const resumeSession = useCallback(
    async (
      sessionId: string,
      questions: InterviewQuestion[],
      previousAnswers: AnswerWithEval[],
      resumeFromIndex: number,
      interviewType?: InterviewType,
      deepMode?: boolean,
      textMode?: boolean
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
          textMode: textMode || false,
          textInput: '',
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
        textMode: textMode || false,
        textInput: '',
        isFollowUp: false,
        followUpRound: 0,
        followUpEvaluations: [],
      });

      if (!textMode) {
        await tts.speak(questions[resumeFromIndex].text);
      }
      answerStartTimeRef.current = Date.now();
      setState((prev) => ({ ...prev, phase: 'listening' }));
      if (!textMode) {
        speech.resetTranscript();
        speech.startListening();
        recorder.startRecording();
        analytics.start('');
      }
    },
    [tts, speech, recorder, analytics]
  );

  const submitAnswer = useCallback(async () => {
    if (!state.sessionId) return;

    const responseTimeSec = Math.round((Date.now() - answerStartTimeRef.current) / 1000);
    let transcript: string;
    let finalMetrics: SpeechMetrics | undefined;

    if (state.textMode) {
      transcript = state.textInput.trim();
      setState((prev) => ({ ...prev, phase: 'evaluating' }));
    } else {
      speech.stopListening();
      const audioBlob = await recorder.stopRecording();
      finalMetrics = analytics.stop();
      const webSpeechTranscript = normalizeTranscript(speech.transcript);

      setState((prev) => ({ ...prev, phase: 'evaluating' }));

      // Whisper 하이브리드
      transcript = webSpeechTranscript;
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
        speechMetrics: finalMetrics,
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
            speechMetrics: finalMetrics,
          },
        ],
      }));
    }
  }, [state.sessionId, state.currentQuestionIndex, state.deepMode, state.textMode, state.textInput, state.questions, speech, recorder, analytics]);

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
      textInput: '',
      isFollowUp: false,
      followUpRound: 0,
      followUpEvaluations: [],
    }));

    // Speak next question (skip TTS in text mode)
    if (!state.textMode) {
      await tts.speak(state.questions[nextIndex].text);
    }
    answerStartTimeRef.current = Date.now();
    setState((prev) => ({ ...prev, phase: 'listening' }));
    if (!state.textMode) {
      speech.resetTranscript();
      speech.startListening();
      recorder.startRecording();
      analytics.reset();
      analytics.start('');
    }
  }, [state.currentQuestionIndex, state.questions, state.sessionId, state.textMode, tts, speech, recorder, analytics]);

  const skipQuestion = useCallback(async () => {
    if (!state.textMode) {
      speech.stopListening();
      recorder.resetRecording();
    }

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
  }, [state.currentQuestionIndex, state.textMode, speech, recorder, nextQuestion]);

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
      textInput: '',
    }));

    if (!state.textMode) {
      await tts.speak(followUpQuestion);
    }
    answerStartTimeRef.current = Date.now();
    setState((prev) => ({ ...prev, phase: 'listening' }));
    if (!state.textMode) {
      speech.resetTranscript();
      speech.startListening();
      recorder.startRecording();
      analytics.reset();
      analytics.start('');
    }
  }, [state.answers, state.currentQuestionIndex, state.followUpRound, state.followUpEvaluations, state.textMode, tts, speech, recorder, analytics]);

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

    let transcript: string;

    if (state.textMode) {
      transcript = state.textInput.trim();
      setState((prev) => ({ ...prev, phase: 'evaluating' }));
    } else {
      speech.stopListening();
      const audioBlob = await recorder.stopRecording();
      analytics.stop();
      const webSpeechTranscript = normalizeTranscript(speech.transcript);

      setState((prev) => ({ ...prev, phase: 'evaluating' }));

      // Whisper 하이브리드
      transcript = webSpeechTranscript;
      if (audioBlob && audioBlob.size > 0) {
        const whisperResult = await transcribeWithWhisper(audioBlob);
        if (whisperResult) {
          transcript = whisperResult;
        }
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
          sessionId: state.sessionId,
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
  }, [state.answers, state.currentQuestionIndex, state.interviewType, state.deepMode, state.textMode, state.textInput, state.questions, state.followUpRound, state.followUpEvaluations, state.sessionId, speech, recorder, analytics]);

  // Determine if more follow-ups are available
  const latestFollowUpEval = state.followUpEvaluations.length > 0
    ? state.followUpEvaluations[state.followUpEvaluations.length - 1]
    : null;
  const canDoMoreFollowUp = state.followUpRound < MAX_FOLLOWUP_ROUNDS &&
    latestFollowUpEval?.followUpQuestion != null;

  const setTextInput = useCallback((text: string) => {
    setState((prev) => ({ ...prev, textInput: text }));
  }, []);

  // Feed transcript to analytics during listening phase
  useEffect(() => {
    if (state.phase === 'listening' && speech.transcript && !state.textMode) {
      analytics.feed(speech.transcript);
    }
  }, [state.phase, speech.transcript, state.textMode, analytics]);

  return {
    ...state,
    speech,
    tts,
    setTextInput,
    speechAnalytics: analytics.metrics,
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
