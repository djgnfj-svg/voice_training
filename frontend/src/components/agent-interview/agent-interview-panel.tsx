'use client';

import { useRef, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import {
  Loader2, Send, Volume2, VolumeX, Mic, SkipForward, ArrowLeft, CheckCircle, Search, Target,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useAgentInterview } from '@/hooks/useAgentInterview';
import { useTextToSpeech } from '@/hooks/useTextToSpeech';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { normalizeTranscript, hasMeaningfulContent } from '@/lib/transcript';
import { scoreBg, scoreText } from '@/lib/score-colors';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { TextAnswerInput } from '@/components/admin/text-answer-input';
import { InterviewerStage, type InterviewerExpression } from './interviewer-stage';

// 답변 중 침묵 자동 제출 타이머. 3s는 사용자가 잠깐 생각만 해도 제출되어 "급해서 연습 안 됨" 피드백의 원인. 30s로 완화.
const SILENCE_TIMEOUT_MS = 30000;

interface AgentInterviewPanelProps {
  resumeId: string;
  jobPostingId?: string;
  onComplete?: (sessionId: string) => void;
}

export function AgentInterviewPanel({
  resumeId,
  jobPostingId,
  onComplete,
}: AgentInterviewPanelProps) {
  const {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions: maxQ,
    error,
    start,
    submitAnswer,
    skip,
    endEarly,
    lastInnerThought,
  } = useAgentInterview();

  const isAdmin = useIsAdmin();
  const [textMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('textMode') === '1';
  });

  const tts = useTextToSpeech({ persona: 'interviewer' });
  const speech = useSpeechRecognition();
  const { speak: ttsSpeak, stop: ttsStop } = tts;
  const {
    startListening: speechStart,
    stopListening: speechStop,
    resetTranscript: speechReset,
  } = speech;
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [answerWarning, setAnswerWarning] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const lastSpokenRef = useRef('');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTranscriptRef = useRef('');

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, phase]);

  // Start interview on mount (once)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start({ resumeId, jobPostingId, textMode });
  }, [resumeId, jobPostingId, start, textMode]);

  // Auto-speak questions, then start listening
  useEffect(() => {
    if (phase !== 'waiting_answer') return;
    if (textMode) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return;
    if (lastMsg.role !== 'agent_question' && lastMsg.role !== 'agent_followup') return;
    if (lastMsg.content === lastSpokenRef.current) return;
    lastSpokenRef.current = lastMsg.content;

    (async () => {
      try {
        await ttsSpeak(lastMsg.content);
      } catch {}
      // Start listening after TTS finishes
      speechReset();
      setAnswerWarning(null);
      speechStart();
    })();
  }, [phase, messages, ttsSpeak, speechReset, speechStart, textMode]);

  // Stop listening when leaving waiting_answer phase
  useEffect(() => {
    if (textMode) return;
    if (phase !== 'waiting_answer' && speech.isListening) {
      speechStop();
    }
    if (phase !== 'waiting_answer' && silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, [phase, speech.isListening, speechStop, textMode]);

  // Silence auto-submit: N초간 transcript 변화 없으면 자동 제출
  useEffect(() => {
    if (phase !== 'waiting_answer') return;
    if (textMode) return;
    if (!speech.isListening) return;
    if (tts.isSpeaking) return;

    const currentText = speech.transcript + '|' + speech.interimTranscript;
    if (currentText === lastTranscriptRef.current) return;
    lastTranscriptRef.current = currentText;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (!speech.transcript.trim() && !speech.interimTranscript.trim()) return;

    silenceTimerRef.current = setTimeout(() => {
      const raw = speech.transcript.trim() || speech.interimTranscript.trim();
      if (!raw) return;
      const text = normalizeTranscript(raw);
      if (!text) return;
      if (!hasMeaningfulContent(text)) {
        // 무의미 답변은 자동 제출하지 않음 — 사용자가 명시적 제출/건너뛰기 선택하도록
        setAnswerWarning('답변이 너무 짧거나 반복된 내용 같습니다. 조금 더 말씀해 주시거나 "건너뛰기"를 눌러주세요.');
        return;
      }
      setAnswerWarning(null);
      ttsStop();
      speechStop();
      submitAnswer(text);
      speechReset();
      lastTranscriptRef.current = '';
    }, SILENCE_TIMEOUT_MS);

    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    };
  }, [
    speech.transcript,
    speech.interimTranscript,
    speech.isListening,
    phase,
    tts.isSpeaking,
    ttsStop,
    speechStop,
    speechReset,
    submitAnswer,
    textMode,
  ]);

  const handleSubmit = () => {
    const transcript = normalizeTranscript(speech.transcript);
    if (!transcript) return;
    if (!hasMeaningfulContent(transcript)) {
      setAnswerWarning('답변이 너무 짧거나 반복된 내용 같습니다. 조금 더 말씀해 주시거나 "건너뛰기"를 눌러주세요.');
      return;
    }
    setAnswerWarning(null);
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    tts.stop();
    speech.stopListening();
    submitAnswer(transcript);
    speech.resetTranscript();
    lastTranscriptRef.current = '';
  };

  const handleSkip = () => {
    tts.stop();
    speech.stopListening();
    speech.resetTranscript();
    skip();
  };

  const handleExit = () => {
    tts.stop();
    speech.stopListening();
    endEarly();
  };

  const isProcessing = [
    'loading_profile',
    'profile_loaded',
    'fit_analyzing',
    'fit_analyzed',
    'scan_plan_ready',
    'dive_plan_ready',
    'generating_question',
    'evaluating',
    'generating_followup',
    'generating_report',
    'updating_profile',
  ].includes(phase);

  const progress = maxQ > 0 ? (questionCount / maxQ) * 100 : 0;

  // Get current question text
  const currentQuestion = [...messages].reverse().find(
    m => m.role === 'agent_question' || m.role === 'agent_followup'
  );

  // Get last evaluation
  const lastEvaluation = [...messages].reverse().find(m => m.role === 'agent_evaluation');

  const expression: InterviewerExpression = (() => {
    if (phase === 'evaluating' || phase === 'generating_followup') return 'thinking';
    if (speech.isListening) return 'listening';
    const ev = lastEvaluation?.evaluation as { overallScore?: number } | undefined;
    if (ev && phase === 'waiting_answer' && typeof ev.overallScore === 'number') {
      if (ev.overallScore >= 80) return 'impressed';
      if (ev.overallScore >= 60) return 'skeptical';
      return 'disappointed';
    }
    return 'neutral';
  })();

  const stageThought: string | null = (() => {
    if (phase === 'evaluating') return '흠... 잠깐 보자';
    if (speech.isListening) return null;
    return lastInnerThought ?? null;
  })();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <Mic className="h-5 w-5 text-primary" />
          <span className="font-bold">보이스프렙</span>
        </Link>
        <Button variant="ghost" size="sm" onClick={() => setShowExitDialog(true)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          면접 나가기
        </Button>
      </div>

      {isAdmin && textMode && (
        <div data-testid="admin-text-mode-active" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Admin 텍스트 모드 활성 (URL ?textMode=1)
        </div>
      )}

      {/* Interviewer Stage */}
      {phase !== 'completed' && (
        <InterviewerStage
          expression={expression}
          innerThought={stageThought}
        />
      )}

      {/* Progress + Volume */}
      <div className="space-y-2">
        <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium">
            질문 {questionCount} / {maxQ}
          </span>
          <div className="flex items-center gap-2">
            <Volume2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={tts.volume}
              onChange={(e) => tts.setVolume(Number(e.target.value))}
              aria-label="음량 조절"
              className="h-1 flex-1 cursor-pointer accent-primary sm:w-24 sm:flex-none"
            />
            <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {Math.round(tts.volume * 100)}%
            </span>
          </div>
        </div>
        <Progress value={progress} />
      </div>

      {/* Current Question */}
      {currentQuestion && phase !== 'completed' && (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-center justify-between mb-3 gap-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <Badge variant="outline">
                  Q{currentQuestion.questionNumber}
                  {currentQuestion.followUpRound ? ` 꼬리질문 ${currentQuestion.followUpRound}` : ''}
                </Badge>
                {currentQuestion.phaseLabel && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                      currentQuestion.phase === 'dive'
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300'
                    )}
                    aria-label={
                      currentQuestion.phase === 'dive'
                        ? `딥다이브 단계: ${currentQuestion.phaseLabel}`
                        : `훑기 단계: ${currentQuestion.phaseLabel}`
                    }
                  >
                    {currentQuestion.phase === 'dive' ? (
                      <Target className="h-3 w-3" />
                    ) : (
                      <Search className="h-3 w-3" />
                    )}
                    {currentQuestion.phaseLabel}
                  </span>
                )}
              </div>
              {tts.isSpeaking && (
                <Button variant="ghost" size="icon" onClick={tts.stop} className="h-8 w-8">
                  <VolumeX className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-lg leading-relaxed">{currentQuestion.content}</p>
          </CardContent>
        </Card>
      )}

      {/* Phase Controls */}
      <Card>
        <CardContent className="py-6">
          {/* Loading phases */}
          {isProcessing && (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                {phase === 'loading_profile' && '프로필 분석 중...'}
                {phase === 'profile_loaded' && '프로필 로드 완료, 적합도 분석 준비 중...'}
                {phase === 'fit_analyzing' && '이력서와 공고 적합도 분석 중...'}
                {phase === 'fit_analyzed' && '적합도 분석 완료, 질문 계획 수립 중...'}
                {phase === 'scan_plan_ready' && '훑기 질문 계획 완료, 첫 질문 생성 중...'}
                {phase === 'dive_plan_ready' && '딥다이브 계획 완료, 다음 질문 생성 중...'}
                {phase === 'generating_question' && '질문 생성 중...'}
                {phase === 'evaluating' && '답변을 평가하고 있습니다...'}
                {phase === 'generating_followup' && '꼬리질문 생성 중...'}
                {phase === 'generating_report' && '리포트 생성 중...'}
                {phase === 'updating_profile' && '프로필 업데이트 중...'}
              </p>
            </div>
          )}

          {phase === 'waiting_answer' && isAdmin && textMode && (
            <TextAnswerInput
              onSubmit={(text) => submitAnswer(text)}
              onSkip={skip}
            />
          )}

          {/* TTS playing */}
          {phase === 'waiting_answer' && tts.isSpeaking && !speech.isListening && !textMode && (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Volume2 className="h-8 w-8 animate-pulse text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">질문을 읽고 있습니다...</p>
            </div>
          )}

          {/* Listening - voice recording */}
          {phase === 'waiting_answer' && speech.isListening && !textMode && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 ring-4 ring-red-100/50 animate-pulse dark:bg-red-900/30 dark:ring-red-900/30">
                  <Mic className="h-8 w-8 text-red-500 dark:text-red-400" />
                </div>
                <p className="text-sm font-medium text-red-500">녹음 중...</p>
              </div>

              {/* Live transcript */}
              <div className="min-h-[100px] rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">실시간 전사:</p>
                <p className="mt-2">
                  {normalizeTranscript(speech.transcript)}
                  <span className="text-muted-foreground">{speech.interimTranscript}</span>
                </p>
              </div>

              {/* 답변 품질 경고 */}
              {answerWarning && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {answerWarning}
                </div>
              )}

              <div className="flex items-center justify-center gap-3">
                <Button variant="outline" onClick={handleSkip}>
                  <SkipForward className="mr-2 h-4 w-4" />
                  건너뛰기
                </Button>
                <Button onClick={handleSubmit} disabled={!speech.transcript}>
                  <Send className="mr-2 h-4 w-4" />
                  답변 제출
                </Button>
              </div>
            </div>
          )}

          {/* Waiting for TTS to finish, not yet listening */}
          {phase === 'waiting_answer' && !tts.isSpeaking && !speech.isListening && !textMode && (
            <div className="flex flex-col items-center gap-4">
              <p className="text-sm text-muted-foreground">마이크 준비 중...</p>
            </div>
          )}

          {/* Last evaluation display */}
          {lastEvaluation?.evaluation && phase === 'waiting_answer' && (
            <div className="mt-4 pt-4 border-t space-y-3">
              <div className="flex items-center gap-3">
                {(() => {
                  const score = (lastEvaluation.evaluation as Record<string, number>).overallScore ?? 0;
                  return (
                    <>
                      <div className={cn(
                        'flex h-12 w-12 items-center justify-center rounded-full',
                        scoreBg(score)
                      )}>
                        <span className={cn('text-lg font-bold', scoreText(score))}>
                          {score}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium">이전 답변: {score}/100</p>
                        <p className="text-sm text-muted-foreground">
                          {(lastEvaluation.evaluation as Record<string, string>).briefFeedback}
                        </p>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-destructive text-sm text-center">{error}</div>
          )}

          {/* Completed */}
          {phase === 'completed' && (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <p className="font-medium">면접이 완료되었습니다</p>
              <Button
                className="w-full"
                onClick={() => sessionId && onComplete?.(sessionId)}
              >
                리포트 확인하기
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Exit confirmation dialog */}
      <Dialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>면접을 나가시겠습니까?</DialogTitle>
            <DialogDescription>
              현재까지의 답변은 저장되어 있습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outline" onClick={() => setShowExitDialog(false)}>
              계속하기
            </Button>
            <Button variant="destructive" onClick={handleExit}>
              나가기
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div ref={messagesEndRef} />
    </div>
  );
}
