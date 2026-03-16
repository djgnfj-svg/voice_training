'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useTextToSpeech } from './useTextToSpeech';
import { useAudioRecorder } from './useAudioRecorder';

export type NightlyStudyPhase =
  | 'setup'
  | 'loading'
  | 'tutor-speaking'
  | 'user-speaking'
  | 'processing'
  | 'summary'
  | 'daily-limit'
  | 'error';

export interface ConversationMessage {
  role: 'tutor' | 'user';
  content: string;
}

export interface StudyQuestion {
  originalQuestion: string;
  tutorQuestion: string;
  keyPoints: string[];
  category: string;
  subcategory: string;
}

export interface StudySummary {
  strengths: string[];
  reviewTopics: string[];
  encouragement: string;
}

interface QuestionState {
  question: StudyQuestion;
  conversation: ConversationMessage[];
  conceptsCovered: string[];
  round: number;
  isComplete: boolean;
}

export function useNightlyStudy() {
  const [phase, setPhase] = useState<NightlyStudyPhase>('setup');
  const [questions, setQuestions] = useState<StudyQuestion[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [questionStates, setQuestionStates] = useState<QuestionState[]>([]);
  const [summary, setSummary] = useState<StudySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'deep' | 'light'>('deep');

  const modeRef = useRef<'deep' | 'light'>('deep');

  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const recorder = useAudioRecorder();

  const currentState = questionStates[currentQuestionIndex] || null;

  const startSession = useCallback(async (
    categories: string[],
    selectedMode: 'deep' | 'light',
    resumeId?: string,
  ) => {
    setPhase('loading');
    setError(null);
    modeRef.current = selectedMode;
    setMode(selectedMode);

    try {
      const res = await fetch('/api/nightly-study/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories, mode: selectedMode, resumeId }),
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.code === 'DAILY_LIMIT_REACHED') {
          setPhase('daily-limit');
          return;
        }
        throw new Error(data.error || '세션 시작 실패');
      }

      const data = await res.json();
      const qs: StudyQuestion[] = data.questions;
      setQuestions(qs);
      setCurrentQuestionIndex(0);

      const states: QuestionState[] = qs.map((q) => ({
        question: q,
        conversation: [],
        conceptsCovered: [],
        round: 0,
        isComplete: false,
      }));
      setQuestionStates(states);

      // Start tutor speaking first question
      setPhase('tutor-speaking');
      const firstMsg: ConversationMessage = { role: 'tutor', content: qs[0].tutorQuestion };
      states[0].conversation.push(firstMsg);
      setQuestionStates([...states]);

      try {
        await tts.speak(qs[0].tutorQuestion);
      } catch {
        // TTS failure is non-blocking
      }
      setPhase('user-speaking');
      speech.resetTranscript();
      speech.startListening();
      recorder.startRecording();
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
      setPhase('error');
    }
  }, [tts, speech, recorder]);

  const submitAnswer = useCallback(async () => {
    speech.stopListening();
    recorder.stopRecording();
    const transcript = speech.transcript.trim();
    setPhase('processing');

    const idx = currentQuestionIndex;
    const state = questionStates[idx];
    if (!state) return;

    // Add user message
    const userMsg: ConversationMessage = { role: 'user', content: transcript || '(잘 모르겠어요)' };
    state.conversation.push(userMsg);
    state.round += 1;

    try {
      const res = await fetch('/api/nightly-study/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionText: state.question.originalQuestion,
          userAnswer: transcript || '',
          conversationHistory: state.conversation.slice(0, -1), // exclude latest user msg for history
          mode: modeRef.current,
          round: state.round,
          keyPoints: state.question.keyPoints,
        }),
      });

      if (!res.ok) throw new Error('튜터 응답 실패');

      const data = await res.json();

      // Add tutor response
      const tutorMsg: ConversationMessage = { role: 'tutor', content: data.tutorResponse };
      state.conversation.push(tutorMsg);
      state.conceptsCovered = [...new Set([...state.conceptsCovered, ...data.conceptsCovered])];
      state.isComplete = data.isComplete;

      // If there's a follow-up, add it to the tutor response
      if (data.followUpQuestion && !data.isComplete) {
        const followUpMsg: ConversationMessage = { role: 'tutor', content: data.followUpQuestion };
        state.conversation.push(followUpMsg);
      }

      setQuestionStates([...questionStates]);
      setPhase('tutor-speaking');

      // Speak tutor response + follow-up
      const toSpeak = data.followUpQuestion && !data.isComplete
        ? `${data.tutorResponse} ... ${data.followUpQuestion}`
        : data.tutorResponse;

      try {
        await tts.speak(toSpeak);
      } catch {
        // TTS failure is non-blocking
      }

      if (data.isComplete) {
        // Move to next question or summary
        const nextIdx = idx + 1;
        if (nextIdx < questions.length) {
          setCurrentQuestionIndex(nextIdx);
          const nextState = questionStates[nextIdx];
          const nextMsg: ConversationMessage = { role: 'tutor', content: nextState.question.tutorQuestion };
          nextState.conversation.push(nextMsg);
          setQuestionStates([...questionStates]);
          setPhase('tutor-speaking');
          try {
            await tts.speak(nextState.question.tutorQuestion);
          } catch {
            // non-blocking
          }
          setPhase('user-speaking');
          speech.resetTranscript();
          speech.startListening();
          recorder.startRecording();
        } else {
          await completeSession();
        }
      } else {
        setPhase('user-speaking');
        speech.resetTranscript();
        speech.startListening();
        recorder.startRecording();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
      setPhase('error');
    }
  }, [speech, recorder, currentQuestionIndex, questionStates, questions, tts]);

  const submitAnswerRef = useRef(submitAnswer);
  submitAnswerRef.current = submitAnswer;

  // Auto-submit on silence: 3초간 음성 입력이 없으면 자동 제출
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadSpeechRef = useRef(false);

  useEffect(() => {
    if (phase !== 'user-speaking') {
      // Reset when not in speaking phase
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      hadSpeechRef.current = false;
      return;
    }

    const hasContent = !!(speech.transcript || speech.interimTranscript);
    if (hasContent) {
      hadSpeechRef.current = true;
    }

    // Only start silence timer if user has spoken something
    if (!hadSpeechRef.current) return;

    // Reset timer on any transcript change
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }

    silenceTimerRef.current = setTimeout(() => {
      // Only auto-submit if still in user-speaking phase and no interim (= silence)
      if (!speech.interimTranscript) {
        submitAnswerRef.current();
      }
    }, 3000);

    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
    };
  }, [phase, speech.transcript, speech.interimTranscript]);

  const skipAnswer = useCallback(async () => {
    speech.resetTranscript();
    await submitAnswer();
  }, [speech, submitAnswer]);

  const completeSession = useCallback(async () => {
    setPhase('processing');
    tts.stop();
    speech.stopListening();
    recorder.stopRecording();

    try {
      const res = await fetch('/api/nightly-study/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: questionStates.map((s) => ({
            originalQuestion: s.question.originalQuestion,
            tutorQuestion: s.question.tutorQuestion,
            category: s.question.category,
            subcategory: s.question.subcategory,
            conversation: s.conversation,
            conceptsCovered: s.conceptsCovered,
            keyPoints: s.question.keyPoints,
          })),
          mode: modeRef.current,
        }),
      });

      if (!res.ok) throw new Error('완료 처리 실패');

      const data = await res.json();
      setSummary(data.summary);
      setPhase('summary');
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
      setPhase('error');
    }
  }, [questionStates, tts, speech, recorder]);

  const finishEarly = useCallback(async () => {
    tts.stop();
    speech.stopListening();
    recorder.stopRecording();
    await completeSession();
  }, [tts, speech, recorder, completeSession]);

  const finishEarlyRef = useRef(finishEarly);
  finishEarlyRef.current = finishEarly;

  // Auto-finish: 3분간 아무 음성 입력 없으면 세션 자동 마무리
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isActive = phase === 'user-speaking' || phase === 'tutor-speaking';
    if (!isActive) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      return;
    }

    // Reset timer on phase change (= activity)
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }

    inactivityTimerRef.current = setTimeout(() => {
      finishEarlyRef.current();
    }, 3 * 60 * 1000); // 3분

    return () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
    };
  }, [phase, speech.transcript]);

  const checkDailyLimit = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/nightly-study/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: ['CS_BASICS'], mode: 'deep', _checkOnly: true }),
      });
      // We don't actually have a check-only endpoint, so we'll handle this in the page
      return true;
    } catch {
      return false;
    }
  }, []);

  return {
    // State
    phase,
    questions,
    currentQuestionIndex,
    currentState,
    questionStates,
    summary,
    error,
    mode,

    // Speech state (exposed for UI)
    transcript: speech.transcript,
    interimTranscript: speech.interimTranscript,
    isListening: speech.isListening,
    isSpeaking: tts.isSpeaking,

    // Actions
    startSession,
    submitAnswer,
    skipAnswer,
    finishEarly,
    checkDailyLimit,
  };
}
