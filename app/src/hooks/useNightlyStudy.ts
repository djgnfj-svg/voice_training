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

function updateQuestionState(
  states: QuestionState[],
  idx: number,
  updater: (state: QuestionState) => QuestionState,
): QuestionState[] {
  return states.map((s, i) => (i === idx ? updater(s) : s));
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
  const resumeIdRef = useRef<string | undefined>(undefined);
  const questionStatesRef = useRef<QuestionState[]>([]);
  questionStatesRef.current = questionStates;

  const questionsRef = useRef<StudyQuestion[]>([]);
  questionsRef.current = questions;

  const currentQuestionIndexRef = useRef(0);
  currentQuestionIndexRef.current = currentQuestionIndex;

  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();
  const recorder = useAudioRecorder();

  const currentState = questionStates[currentQuestionIndex] || null;

  const completeSession = useCallback(async () => {
    setPhase('processing');
    tts.stop();
    speech.stopListening();
    recorder.stopRecording();

    try {
      const states = questionStatesRef.current;
      const res = await fetch('/api/nightly-study/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: states.map((s) => ({
            originalQuestion: s.question.originalQuestion,
            tutorQuestion: s.question.tutorQuestion,
            category: s.question.category,
            subcategory: s.question.subcategory,
            conversation: s.conversation,
            conceptsCovered: s.conceptsCovered,
            keyPoints: s.question.keyPoints,
          })),
          mode: modeRef.current,
          resumeId: resumeIdRef.current,
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
  }, [tts, speech, recorder]);

  const completeSessionRef = useRef(completeSession);
  completeSessionRef.current = completeSession;

  const startSession = useCallback(async (
    categories: string[],
    selectedMode: 'deep' | 'light',
    resumeId?: string,
  ) => {
    setPhase('loading');
    setError(null);
    modeRef.current = selectedMode;
    resumeIdRef.current = resumeId;
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

      const firstMsg: ConversationMessage = { role: 'tutor', content: qs[0].tutorQuestion };
      const states: QuestionState[] = qs.map((q, i) => ({
        question: q,
        conversation: i === 0 ? [firstMsg] : [],
        conceptsCovered: [],
        round: 0,
        isComplete: false,
      }));
      setQuestionStates(states);

      setPhase('tutor-speaking');
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

    const idx = currentQuestionIndexRef.current;
    const states = questionStatesRef.current;
    const state = states[idx];
    if (!state) return;

    const userMsg: ConversationMessage = { role: 'user', content: transcript || '(잘 모르겠어요)' };
    const newRound = state.round + 1;

    // Immutable update: add user message + increment round
    const withUserMsg = updateQuestionState(states, idx, (s) => ({
      ...s,
      conversation: [...s.conversation, userMsg],
      round: newRound,
    }));
    setQuestionStates(withUserMsg);

    try {
      const res = await fetch('/api/nightly-study/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionText: state.question.originalQuestion,
          userAnswer: transcript || '',
          conversationHistory: state.conversation, // pre-update snapshot (excludes current userMsg)
          mode: modeRef.current,
          round: newRound,
          keyPoints: state.question.keyPoints,
        }),
      });

      if (!res.ok) throw new Error('튜터 응답 실패');

      const data = await res.json();

      const tutorMsg: ConversationMessage = { role: 'tutor', content: data.tutorResponse };
      const followUpMsg: ConversationMessage | null =
        data.followUpQuestion && !data.isComplete
          ? { role: 'tutor', content: data.followUpQuestion }
          : null;

      // Immutable update: add tutor response + follow-up + concepts
      const latestStates = questionStatesRef.current;
      const withTutor = updateQuestionState(latestStates, idx, (s) => ({
        ...s,
        conversation: [
          ...s.conversation,
          tutorMsg,
          ...(followUpMsg ? [followUpMsg] : []),
        ],
        conceptsCovered: [...new Set([...s.conceptsCovered, ...data.conceptsCovered])],
        isComplete: data.isComplete,
      }));
      setQuestionStates(withTutor);

      setPhase('tutor-speaking');

      const toSpeak = followUpMsg
        ? `${data.tutorResponse} ... ${data.followUpQuestion}`
        : data.tutorResponse;

      try {
        await tts.speak(toSpeak);
      } catch {
        // TTS failure is non-blocking
      }

      if (data.isComplete) {
        const nextIdx = idx + 1;
        if (nextIdx < questionsRef.current.length) {
          setCurrentQuestionIndex(nextIdx);
          const nextQ = questionsRef.current[nextIdx];
          const nextMsg: ConversationMessage = { role: 'tutor', content: nextQ.tutorQuestion };

          setQuestionStates((prev) =>
            updateQuestionState(prev, nextIdx, (s) => ({
              ...s,
              conversation: [...s.conversation, nextMsg],
            }))
          );

          setPhase('tutor-speaking');
          try {
            await tts.speak(nextQ.tutorQuestion);
          } catch {
            // non-blocking
          }
          setPhase('user-speaking');
          speech.resetTranscript();
          speech.startListening();
          recorder.startRecording();
        } else {
          await completeSessionRef.current();
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
  }, [speech, recorder, tts]);

  const submitAnswerRef = useRef(submitAnswer);
  submitAnswerRef.current = submitAnswer;

  // Auto-submit on silence: 3초간 음성 입력이 없으면 자동 제출
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadSpeechRef = useRef(false);

  useEffect(() => {
    if (phase !== 'user-speaking') {
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

    if (!hadSpeechRef.current) return;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }

    silenceTimerRef.current = setTimeout(() => {
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
    await submitAnswerRef.current();
  }, [speech]);

  const finishEarly = useCallback(async () => {
    tts.stop();
    speech.stopListening();
    recorder.stopRecording();
    await completeSessionRef.current();
  }, [tts, speech, recorder]);

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

    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }

    inactivityTimerRef.current = setTimeout(() => {
      finishEarlyRef.current();
    }, 3 * 60 * 1000);

    return () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
    };
  }, [phase, speech.transcript]);

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
  };
}
