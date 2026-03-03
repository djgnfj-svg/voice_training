'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { useInterviewSession } from '@/hooks/useInterviewSession';
import { Mic, MicOff, SkipForward, Send, Volume2, Loader2, CheckCircle, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InterviewQuestion, InterviewType } from '@/types';

export default function InterviewSessionPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const interview = useInterviewSession();

  // Load session data on mount
  useEffect(() => {
    if (initialized) return;

    async function loadSession() {
      try {
        const res = await fetch(`/api/interview/${sessionId}/questions`);
        if (!res.ok) {
          // If questions endpoint doesn't exist, try loading from session setup response stored in sessionStorage
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
        setQuestions(data.questions);
        setInitialized(true);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '세션을 불러올 수 없습니다');
      }
    }

    // Check sessionStorage first (set during setup)
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

  // Start session when questions are loaded
  useEffect(() => {
    if (initialized && questions.length > 0 && interview.phase === 'idle') {
      let interviewType: InterviewType | undefined;
      let deepMode = false;
      try {
        const stored = sessionStorage.getItem(`interview_${sessionId}`);
        if (stored) {
          const data = JSON.parse(stored);
          if (data.plan?.type) interviewType = data.plan.type;
          if (data.deepMode) deepMode = true;
        }
      } catch {}
      interview.startSession(sessionId, questions, interviewType, deepMode);
    }
  }, [initialized, questions, interview.phase, sessionId]);

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
    <div className="mx-auto max-w-3xl space-y-6">
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
          {/* Asking phase - TTS playing */}
          {interview.phase === 'asking' && (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Volume2 className="h-8 w-8 animate-pulse text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">
                {interview.isFollowUp ? '꼬리질문을 읽고 있습니다...' : '질문을 읽고 있습니다...'}
              </p>
            </div>
          )}

          {/* Listening phase - Recording */}
          {interview.phase === 'listening' && (
            <div className="space-y-4">
              {/* Follow-up question display */}
              {interview.isFollowUp && currentAnswer?.evaluation?.followUpQuestion && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400">꼬리질문</p>
                  <p className="mt-1 text-sm">{currentAnswer.evaluation.followUpQuestion}</p>
                </div>
              )}

              <div className="flex flex-col items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 ring-4 ring-red-100/50 animate-pulse">
                  <Mic className="h-8 w-8 text-red-500" />
                </div>
                <p className="text-sm font-medium text-red-500">녹음 중...</p>
              </div>

              {/* Live transcript */}
              <div className="min-h-[100px] rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">실시간 전사:</p>
                <p className="mt-2">
                  {interview.speech.transcript}
                  <span className="text-muted-foreground">{interview.speech.interimTranscript}</span>
                </p>
              </div>

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
                  disabled={!interview.speech.transcript}
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
                  score >= 80 ? 'bg-green-100' : score >= 60 ? 'bg-blue-100' : score >= 40 ? 'bg-amber-100' : 'bg-red-100'
                )}>
                  <span className={cn(
                    'text-lg font-bold',
                    score >= 80 ? 'text-green-600' : score >= 60 ? 'text-blue-600' : score >= 40 ? 'text-amber-600' : 'text-red-600'
                  )}>
                    {score}
                  </span>
                </div>
                <div>
                  <p className="font-medium">점수: {currentAnswer.evaluation.overallScore}/100</p>
                  <p className="text-sm text-muted-foreground">
                    응답 시간: {currentAnswer.responseTimeSec}초
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
              {/* Follow-up question text */}
              {currentAnswer?.evaluation?.followUpQuestion && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400">꼬리질문</p>
                  <p className="mt-1 text-sm">{currentAnswer.evaluation.followUpQuestion}</p>
                </div>
              )}

              {interview.followUpEvaluation ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
                      <span className="text-lg font-bold text-amber-600 dark:text-amber-400">
                        {interview.followUpEvaluation.overallScore}
                      </span>
                    </div>
                    <div>
                      <p className="font-medium">꼬리질문 점수: {interview.followUpEvaluation.overallScore}/100</p>
                    </div>
                  </div>

                  <div className="rounded-lg bg-muted/50 p-4">
                    <p className="text-sm font-medium">피드백</p>
                    <p className="mt-1 text-sm">{interview.followUpEvaluation.briefFeedback}</p>
                  </div>
                </>
              ) : (
                <p className="text-center text-sm text-muted-foreground">
                  꼬리질문 평가에 실패했습니다.
                </p>
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
        <Card className="border-yellow-200 bg-yellow-50">
          <CardContent className="py-4">
            <p className="text-sm text-yellow-800">
              이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge 브라우저를 사용해주세요.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
