'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { useInterviewSession } from '@/hooks/useInterviewSession';
import { normalizeTranscript } from '@/lib/transcript';
import { Mic, SkipForward, Send, Volume2, Loader2, CheckCircle, MessageCircle, AlertTriangle, ArrowLeft, Keyboard } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InterviewQuestion, InterviewType, AnswerEvaluation } from '@/types';

interface QuestionWithAnswer {
  index: number;
  text: string;
  source: string;
  category: string;
  difficulty: string;
  answer?: {
    answerTranscript: string;
    overallScore: number | null;
    briefFeedback: string | null;
    detailedFeedback: string | null;
    modelAnswer: string | null;
    followUpQuestion: string | null;
    scores: Record<string, number> | null;
    responseTimeSec: number | null;
  } | null;
}

export default function InterviewSessionPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isResumed, setIsResumed] = useState(false);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const exitTargetRef = useRef<string | null>(null);

  const interview = useInterviewSession();

  // Stable refs for interview functions to avoid effect re-triggers
  const resumeSessionRef = useRef(interview.resumeSession);
  resumeSessionRef.current = interview.resumeSession;
  const startSessionRef = useRef(interview.startSession);
  startSessionRef.current = interview.startSession;

  // Exit prevention: beforeunload
  useEffect(() => {
    const isActive = ['asking', 'listening', 'evaluating', 'feedback'].includes(interview.phase);
    if (!isActive) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [interview.phase]);

  // Exit prevention: popstate (back button)
  useEffect(() => {
    const isActive = ['asking', 'listening', 'evaluating', 'feedback'].includes(interview.phase);
    if (!isActive) return;

    // Push a dummy state so back button triggers popstate instead of leaving
    window.history.pushState({ interviewGuard: true }, '');

    const handler = () => {
      // Re-push to keep blocking
      window.history.pushState({ interviewGuard: true }, '');
      setShowExitDialog(true);
      exitTargetRef.current = null; // back button: go to setup
    };

    window.addEventListener('popstate', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      // Clean up the dummy history entry
      if (window.history.state?.interviewGuard) {
        window.history.back();
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExitConfirm = useCallback(() => {
    interview.tts.stop();
    interview.speech.stopListening();
    setShowExitDialog(false);
    router.push(exitTargetRef.current || '/interview/setup');
  }, [router, interview.tts, interview.speech]);

  // Load session data on mount
  useEffect(() => {
    if (initialized) return;

    async function loadSession() {
      try {
        const res = await fetch(`/api/interview/${sessionId}/questions`);
        if (!res.ok) {
          const stored = sessionStorage.getItem(`interview_${sessionId}`);
          if (stored) {
            const data = JSON.parse(stored);
            setQuestions(data.questions);
            setInitialized(true);
            return;
          }
          throw new Error('Failed to load session');
        }
        const data = await res.json();

        // Check if this is a resume scenario (API loaded, has answer data)
        const questionsData = data.questions as QuestionWithAnswer[];
        const hasAnsweredQuestions = questionsData.some((q: QuestionWithAnswer) => q.answer != null);

        if (hasAnsweredQuestions && data.sessionStatus === 'IN_PROGRESS') {
          // Resume mode: find first unanswered question
          const resumeFromIndex = questionsData.findIndex((q: QuestionWithAnswer) => q.answer == null);
          const finalResumeIndex = resumeFromIndex === -1 ? questionsData.length : resumeFromIndex;

          // Build previous answers for the hook
          const previousAnswers = questionsData
            .filter((q: QuestionWithAnswer) => q.answer != null)
            .map((q: QuestionWithAnswer) => ({
              questionIndex: q.index,
              transcript: q.answer!.answerTranscript,
              evaluation: q.answer!.overallScore !== null ? {
                scores: (q.answer!.scores || {}) as unknown as AnswerEvaluation['scores'],
                overallScore: q.answer!.overallScore,
                briefFeedback: q.answer!.briefFeedback || '',
                detailedFeedback: q.answer!.detailedFeedback || '',
                modelAnswer: q.answer!.modelAnswer || '',
                followUpQuestion: q.answer!.followUpQuestion || undefined,
              } : null,
              responseTimeSec: q.answer!.responseTimeSec || 0,
            }));

          // Convert to InterviewQuestion format
          const mappedQuestions: InterviewQuestion[] = questionsData.map((q: QuestionWithAnswer) => ({
            index: q.index,
            text: q.text,
            source: q.source as InterviewQuestion['source'],
            category: q.category,
            difficulty: q.difficulty as InterviewQuestion['difficulty'],
          }));

          setQuestions(mappedQuestions);
          setIsResumed(true);
          setInitialized(true);

          // Directly call resumeSession
          resumeSessionRef.current(
            sessionId,
            mappedQuestions,
            previousAnswers,
            finalResumeIndex,
            data.interviewType as InterviewType,
            data.deepMode,
            data.textMode
          );
          return;
        }

        // Normal load (fresh session via API, no sessionStorage)
        const mappedQuestions: InterviewQuestion[] = questionsData.map((q: QuestionWithAnswer) => ({
          index: q.index,
          text: q.text,
          source: q.source as InterviewQuestion['source'],
          category: q.category,
          difficulty: q.difficulty as InterviewQuestion['difficulty'],
        }));
        setQuestions(mappedQuestions);
        setInitialized(true);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '세션을 불러올 수 없습니다');
      }
    }

    // Check sessionStorage first (set during setup — means fresh start)
    const stored = sessionStorage.getItem(`interview_${sessionId}`);
    if (stored) {
      try {
        const data = JSON.parse(stored);
        setQuestions(data.questions);
        setInitialized(true);
      } catch {
        loadSession();
      }
    } else {
      loadSession();
    }
  }, [sessionId, initialized]);

  // Start session when questions are loaded (only for fresh sessions, not resumed)
  useEffect(() => {
    if (initialized && questions.length > 0 && interview.phase === 'idle' && !isResumed) {
      let interviewType: InterviewType | undefined;
      let deepMode = false;
      let textMode = false;
      try {
        const stored = sessionStorage.getItem(`interview_${sessionId}`);
        if (stored) {
          const data = JSON.parse(stored);
          if (data.plan?.type) interviewType = data.plan.type;
          if (data.deepMode) deepMode = true;
          if (data.textMode) textMode = true;
        }
      } catch {}
      startSessionRef.current(sessionId, questions, interviewType, deepMode, textMode);
    }
  }, [initialized, questions, interview.phase, sessionId, isResumed]);

  // Navigate to report when completed
  useEffect(() => {
    if (interview.phase === 'completed') {
      router.push(`/interview/report/${sessionId}`);
    }
  }, [interview.phase, sessionId, router]);

  if (error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-8 text-center">
            <p className="text-destructive">{error}</p>
            <Button className="mt-4" onClick={() => router.push('/interview/setup')}>
              면접 설정으로 돌아가기
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!initialized) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const currentAnswer = interview.answers.find(
    (a) => a.questionIndex === interview.currentQuestionIndex
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      {/* Exit button */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowExitDialog(true)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          면접 나가기
        </Button>
      </div>

      {/* Resume notice */}
      {isResumed && interview.phase !== 'completed' && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950">
          <AlertTriangle className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-sm text-blue-700 dark:text-blue-300">
            이전 진행 상황을 불러왔습니다. 이어서 진행합니다.
          </p>
        </div>
      )}

      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            질문 {interview.currentQuestionIndex + 1} / {interview.totalQuestions}
          </span>
          <span className="text-muted-foreground">
            {Math.round(interview.progress)}%
          </span>
        </div>
        <Progress value={interview.progress} />
      </div>

      {/* Current Question */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              Q{interview.currentQuestionIndex + 1}.
            </CardTitle>
            {interview.currentQuestion && (
              <Badge variant={interview.currentQuestion.source === 'deep_technical' ? 'default' : 'outline'}
                className={interview.currentQuestion.source === 'deep_technical' ? 'bg-violet-600' : ''}>
                {interview.currentQuestion.source === 'job_posting'
                  ? '공고 맞춤'
                  : interview.currentQuestion.source === 'resume_based'
                  ? '이력서 기반'
                  : interview.currentQuestion.source === 'deep_technical'
                  ? '심화'
                  : '일반'}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-lg leading-relaxed">
            {interview.currentQuestion?.text || '질문을 로딩 중...'}
          </p>
        </CardContent>
      </Card>

      {/* Phase Indicator & Controls */}
      <Card>
        <CardContent className="py-6">
          {/* Asking phase - TTS playing (skip in text mode) */}
          {interview.phase === 'asking' && !interview.textMode && (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Volume2 className="h-8 w-8 animate-pulse text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">
                {interview.isFollowUp
                  ? `꼬리질문 ${interview.followUpRound}/${2}을 읽고 있습니다...`
                  : '질문을 읽고 있습니다...'}
              </p>
            </div>
          )}

          {/* Listening phase - Recording or Text Input */}
          {interview.phase === 'listening' && (
            <div className="space-y-4">
              {/* Follow-up question display */}
              {interview.isFollowUp && (() => {
                const followUpQ = interview.followUpRound === 1
                  ? currentAnswer?.evaluation?.followUpQuestion
                  : interview.followUpEvaluations[interview.followUpEvaluations.length - 1]?.followUpQuestion;
                return followUpQ ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                    <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      꼬리질문 {interview.followUpRound}/2
                    </p>
                    <p className="mt-1 text-sm">{followUpQ}</p>
                  </div>
                ) : null;
              })()}

              {interview.textMode ? (
                <>
                  {/* Text input mode */}
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                      <Keyboard className="h-6 w-6 text-primary" />
                    </div>
                    <p className="text-sm text-muted-foreground">텍스트 입력 모드</p>
                  </div>
                  <textarea
                    className="min-h-[120px] w-full rounded-lg border bg-muted/50 p-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="답변을 입력하세요..."
                    value={interview.textInput}
                    onChange={(e) => interview.setTextInput(e.target.value)}
                    autoFocus
                  />
                </>
              ) : (
                <>
                  {/* Voice mode */}
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
                      {normalizeTranscript(interview.speech.transcript)}
                      <span className="text-muted-foreground">{interview.speech.interimTranscript}</span>
                    </p>
                  </div>

                  {/* Real-time speech metrics */}
                  {(() => {
                    const m = interview.speechAnalytics;
                    const wpmStatus = m.wpm < 200 ? { label: '느림', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' }
                      : m.wpm > 350 ? { label: '빠름', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' }
                      : { label: '적정', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' };
                    const fillerStatus = m.fillerCount <= 2 ? { label: '양호', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' }
                      : m.fillerCount <= 5 ? { label: '주의', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' }
                      : { label: '많음', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' };
                    return (
                      <div className="grid grid-cols-3 gap-2 rounded-lg border p-3">
                        <div className="text-center">
                          <p className="text-xs text-muted-foreground">말 속도</p>
                          <p className="text-lg font-bold">{m.wpm}</p>
                          <Badge variant="outline" className={cn('text-[10px]', wpmStatus.color)}>
                            {wpmStatus.label}
                          </Badge>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-muted-foreground">침묵</p>
                          <p className="text-lg font-bold">{m.silenceSec}초</p>
                          <p className="text-[10px] text-muted-foreground">
                            {Math.round(m.silenceRatio * 100)}%
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-muted-foreground">필러워드</p>
                          <p className="text-lg font-bold">{m.fillerCount}</p>
                          <Badge variant="outline" className={cn('text-[10px]', fillerStatus.color)}>
                            {fillerStatus.label}
                          </Badge>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}

              <div className="flex items-center justify-center gap-3">
                {interview.isFollowUp ? (
                  <Button variant="outline" onClick={interview.nextQuestion}>
                    <SkipForward className="mr-2 h-4 w-4" />
                    건너뛰기
                  </Button>
                ) : (
                  <Button variant="outline" onClick={interview.skipQuestion}>
                    <SkipForward className="mr-2 h-4 w-4" />
                    건너뛰기
                  </Button>
                )}
                <Button
                  onClick={interview.isFollowUp ? interview.submitFollowUpAnswer : interview.submitAnswer}
                  disabled={interview.textMode ? !interview.textInput.trim() : !interview.speech.transcript}
                >
                  <Send className="mr-2 h-4 w-4" />
                  답변 제출
                </Button>
              </div>
            </div>
          )}

          {/* Evaluating phase */}
          {interview.phase === 'evaluating' && (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                {interview.isFollowUp ? '꼬리질문 답변을 평가하고 있습니다...' : '답변을 평가하고 있습니다...'}
              </p>
            </div>
          )}

          {/* Feedback phase — main question */}
          {interview.phase === 'feedback' && !interview.isFollowUp && currentAnswer?.evaluation && (() => {
            const score = currentAnswer.evaluation!.overallScore;
            return (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-full',
                  score >= 80 ? 'bg-green-100 dark:bg-green-900/30' : score >= 60 ? 'bg-blue-100 dark:bg-blue-900/30' : score >= 40 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-red-100 dark:bg-red-900/30'
                )}>
                  <span className={cn(
                    'text-lg font-bold',
                    score >= 80 ? 'text-green-600 dark:text-green-400' : score >= 60 ? 'text-blue-600 dark:text-blue-400' : score >= 40 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
                  )}>
                    {score}
                  </span>
                </div>
                <div>
                  <p className="font-medium">점수: {currentAnswer.evaluation.overallScore}/100</p>
                  <p className="text-sm text-muted-foreground">
                    응답 시간: {currentAnswer.responseTimeSec}초
                    {currentAnswer.speechMetrics && (
                      <span className="ml-2">
                        | 말 속도 {currentAnswer.speechMetrics.wpm}음절/분 | 필러워드 {currentAnswer.speechMetrics.fillerCount}회 | 침묵 {currentAnswer.speechMetrics.silenceSec}초
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {currentAnswer.evaluation.correctedTranscript && (
                <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-950/30">
                  <p className="text-xs font-medium text-blue-600 dark:text-blue-400">AI 교정 텍스트</p>
                  <p className="mt-1 text-sm">{currentAnswer.evaluation.correctedTranscript}</p>
                </div>
              )}

              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-sm font-medium">피드백</p>
                <p className="mt-1 text-sm">{currentAnswer.evaluation.briefFeedback}</p>
              </div>

              {/* Follow-up question prompt */}
              {currentAnswer.evaluation.followUpQuestion && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400">꼬리질문</p>
                  <p className="mt-1 text-sm">{currentAnswer.evaluation.followUpQuestion}</p>
                  <Button
                    variant="outline"
                    className="mt-3 border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-900"
                    onClick={interview.startFollowUp}
                  >
                    <MessageCircle className="mr-2 h-4 w-4" />
                    꼬리질문 답변하기
                  </Button>
                </div>
              )}

              <Button className="w-full" onClick={interview.nextQuestion}>
                {interview.currentQuestionIndex + 1 >= interview.totalQuestions ? (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    면접 완료 및 리포트 보기
                  </>
                ) : (
                  '다음 질문'
                )}
              </Button>
            </div>
            );
          })()}

          {/* Feedback phase — follow-up question */}
          {interview.phase === 'feedback' && interview.isFollowUp && (
            <div className="space-y-4">
              {/* All follow-up evaluations */}
              {interview.followUpEvaluations.map((fuEval, idx) => {
                const fuQuestion = idx === 0
                  ? currentAnswer?.evaluation?.followUpQuestion
                  : interview.followUpEvaluations[idx - 1]?.followUpQuestion;
                return (
                  <div key={idx} className="space-y-3">
                    {fuQuestion && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                        <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                          꼬리질문 {idx + 1}/2
                        </p>
                        <p className="mt-1 text-sm">{fuQuestion}</p>
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
                        <span className="text-lg font-bold text-amber-600 dark:text-amber-400">
                          {fuEval.overallScore}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium">꼬리질문 {idx + 1} 점수: {fuEval.overallScore}/100</p>
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted/50 p-4">
                      <p className="text-sm font-medium">피드백</p>
                      <p className="mt-1 text-sm">{fuEval.briefFeedback}</p>
                    </div>
                  </div>
                );
              })}

              {interview.followUpEvaluations.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">
                  꼬리질문 평가에 실패했습니다.
                </p>
              )}

              {/* Additional follow-up button */}
              {interview.canDoMoreFollowUp && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400">추가 꼬리질문</p>
                  <p className="mt-1 text-sm">
                    {interview.followUpEvaluations[interview.followUpEvaluations.length - 1]?.followUpQuestion}
                  </p>
                  <Button
                    variant="outline"
                    className="mt-3 border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-900"
                    onClick={interview.startFollowUp}
                  >
                    <MessageCircle className="mr-2 h-4 w-4" />
                    꼬리질문 {interview.followUpRound + 1}/2 답변하기
                  </Button>
                </div>
              )}

              <Button className="w-full" onClick={interview.nextQuestion}>
                {interview.currentQuestionIndex + 1 >= interview.totalQuestions ? (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    면접 완료 및 리포트 보기
                  </>
                ) : (
                  '다음 질문'
                )}
              </Button>
            </div>
          )}

          {/* Feedback phase without evaluation (skipped or error) */}
          {interview.phase === 'feedback' && !interview.isFollowUp && !currentAnswer?.evaluation && (
            <div className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                {currentAnswer?.transcript === '(건너뜀)' ? '질문을 건너뛰었습니다.' : '평가에 실패했습니다.'}
              </p>
              <Button className="w-full" onClick={interview.nextQuestion}>
                {interview.currentQuestionIndex + 1 >= interview.totalQuestions
                  ? '면접 완료 및 리포트 보기'
                  : '다음 질문'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Speech API not supported warning */}
      {!interview.speech.isSupported && (
        <Card className="border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950">
          <CardContent className="py-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge 브라우저를 사용해주세요.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Exit confirmation dialog */}
      <Dialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>면접을 나가시겠습니까?</DialogTitle>
            <DialogDescription>
              현재까지의 답변은 저장되어 있습니다. 나중에 이어서 진행할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outline" onClick={() => setShowExitDialog(false)}>
              계속하기
            </Button>
            <Button variant="destructive" onClick={handleExitConfirm}>
              나가기
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
