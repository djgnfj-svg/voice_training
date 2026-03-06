'use client';

import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { usePracticeSession } from '@/hooks/usePracticeSession';
import { normalizeTranscript } from '@/lib/transcript';
import {
  Loader2, ArrowLeft, Mic, Send, Volume2,
  SkipForward, RotateCcw, ChevronRight, CheckCircle, Sparkles,
} from 'lucide-react';

const sourceLabels: Record<string, string> = {
  job_posting: '공고 맞춤',
  resume_based: '이력서 기반',
  general: '일반',
  company_specific: '기업 맞춤',
};

export default function PracticePage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const practice = usePracticeSession(sessionId);

  if (practice.isLoading || practice.phase === 'loading') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-muted-foreground">연습 데이터를 불러오고 있습니다...</p>
        </div>
      </div>
    );
  }

  if (practice.error || !practice.data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-8 text-center">
            <p className="text-destructive">
              {practice.error instanceof Error ? practice.error.message : '데이터를 불러올 수 없습니다'}
            </p>
            <Button className="mt-4" onClick={() => router.push('/history')}>
              기록으로 돌아가기
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Select phase — question list for choosing individual or full review
  if (practice.phase === 'select') {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => router.push('/history')}>
            <ArrowLeft className="mr-1 h-4 w-4" /> 기록으로 돌아가기
          </Button>
          <Button variant="ghost" size="sm" onClick={() => router.push(`/interview/report/${sessionId}`)}>
            리포트 보기
          </Button>
        </div>

        <div>
          <h1 className="text-2xl font-bold">복습할 질문 선택</h1>
          <p className="text-muted-foreground">질문을 선택하거나 전체 복습을 시작하세요</p>
        </div>

        <Button className="w-full" onClick={practice.startAll}>
          전체 복습 시작
        </Button>

        <div className="space-y-3">
          {practice.data.answers.map((answer, idx) => (
            <Card
              key={idx}
              className="cursor-pointer transition-colors hover:bg-accent/50"
              onClick={() => practice.goToQuestion(idx)}
            >
              <CardContent className="flex items-center justify-between py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    Q{idx + 1}. {answer.questionText}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {sourceLabels[answer.questionSource] || answer.questionSource}
                    </Badge>
                  </div>
                </div>
                <div className="ml-4 text-right">
                  {answer.overallScore !== null ? (
                    <span className="text-lg font-bold text-primary">
                      {answer.overallScore}점
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">-</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Summary phase
  if (practice.phase === 'summary') {
    const practiced = practice.results.length;
    const evaluated = practice.results.filter(r => r.evaluation).length;
    const avgScore = evaluated > 0
      ? Math.round(
          practice.results
            .filter(r => r.evaluation)
            .reduce((sum, r) => sum + (r.evaluation!.overallScore ?? 0), 0) / evaluated
        )
      : null;

    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <Button variant="ghost" size="sm" onClick={() => router.push(`/interview/report/${sessionId}`)}>
            <ArrowLeft className="mr-1 h-4 w-4" /> 리포트로 돌아가기
          </Button>
          <h1 className="mt-2 text-3xl font-bold">연습 완료</h1>
        </div>

        <Card>
          <CardContent className="py-8">
            <div className="flex items-center justify-center gap-8">
              <div className="text-center">
                <div className="text-4xl font-bold text-primary">{practiced}</div>
                <p className="text-sm text-muted-foreground">연습한 질문</p>
              </div>
              <div className="text-center">
                <div className="text-4xl font-bold text-blue-500">{evaluated}</div>
                <p className="text-sm text-muted-foreground">AI 평가 받은 질문</p>
              </div>
              {avgScore !== null && (
                <div className="text-center">
                  <div className="text-4xl font-bold text-green-500">{avgScore}</div>
                  <p className="text-sm text-muted-foreground">평균 점수</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Per-question summary */}
        <div className="space-y-3">
          {practice.data.answers.map((answer, idx) => {
            const result = practice.results.find(r => r.questionIndex === idx);
            return (
              <Card
                key={idx}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => practice.goToQuestion(idx)}
              >
                <CardContent className="flex items-center justify-between py-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      Q{idx + 1}. {answer.questionText}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {sourceLabels[answer.questionSource] || answer.questionSource}
                      </Badge>
                      {result ? (
                        <Badge variant="default" className="text-xs">연습 완료</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">미연습</Badge>
                      )}
                    </div>
                  </div>
                  <div className="ml-4 text-right">
                    {result?.evaluation ? (
                      <span className="text-lg font-bold text-primary">
                        {result.evaluation.overallScore}점
                      </span>
                    ) : answer.overallScore !== null ? (
                      <span className="text-sm text-muted-foreground">
                        이전 {answer.overallScore}점
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={practice.goToSelect}>
            질문 선택으로
          </Button>
          <Button variant="outline" className="flex-1" onClick={() => router.push(`/interview/report/${sessionId}`)}>
            리포트 보기
          </Button>
          <Button className="flex-1" onClick={() => router.push('/interview/setup')}>
            새 면접 시작
          </Button>
        </div>
      </div>
    );
  }

  // Question practice flow (reviewing / practicing / comparing)
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={practice.goToSelect}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 질문 선택
        </Button>
        <Button variant="ghost" size="sm" onClick={practice.goToSummary}>
          요약 보기 <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>

      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            질문 {practice.currentIndex + 1} / {practice.totalQuestions}
          </span>
          <span className="text-muted-foreground">{Math.round(practice.progress)}%</span>
        </div>
        <Progress value={practice.progress} />
      </div>

      {/* Question card */}
      {practice.currentAnswer && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Q{practice.currentIndex + 1}.</CardTitle>
              <Badge variant="outline">
                {sourceLabels[practice.currentAnswer.questionSource] || practice.currentAnswer.questionSource}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-lg leading-relaxed">{practice.currentAnswer.questionText}</p>
          </CardContent>
        </Card>
      )}

      {/* Phase content */}
      <Card>
        <CardContent className="py-6">
          {/* Reviewing phase */}
          {practice.phase === 'reviewing' && practice.currentAnswer && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm text-muted-foreground">
                  이전 점수: {practice.currentAnswer.overallScore !== null
                    ? `${practice.currentAnswer.overallScore}점`
                    : '-'}
                </p>
                {practice.currentAnswer.briefFeedback && (
                  <p className="text-center text-sm">{practice.currentAnswer.briefFeedback}</p>
                )}
              </div>
              <div className="flex items-center justify-center gap-3">
                <Button onClick={practice.startPractice}>
                  <Mic className="mr-2 h-4 w-4" />
                  연습 시작
                </Button>
                <Button
                  variant="outline"
                  onClick={practice.showModelAnswer}
                >
                  모범 답안 보기
                </Button>
              </div>
            </div>
          )}

          {/* Practicing phase - TTS playing or STT recording */}
          {practice.phase === 'practicing' && (
            <div className="space-y-4">
              {practice.tts.isSpeaking ? (
                <div className="flex flex-col items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                    <Volume2 className="h-8 w-8 animate-pulse text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground">질문을 읽고 있습니다...</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
                      <Mic className="h-8 w-8 text-red-500" />
                    </div>
                    <p className="text-sm font-medium text-red-500">녹음 중...</p>
                  </div>

                  <div className="min-h-[100px] rounded-lg bg-muted/50 p-4">
                    <p className="text-sm text-muted-foreground">실시간 전사:</p>
                    <p className="mt-2">
                      {normalizeTranscript(practice.speech.transcript)}
                      <span className="text-muted-foreground">{practice.speech.interimTranscript}</span>
                    </p>
                  </div>

                  <div className="flex items-center justify-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        practice.speech.stopListening();
                        practice.speech.resetTranscript();
                        practice.goToQuestion(practice.currentIndex);
                      }}
                    >
                      취소
                    </Button>
                    <Button
                      onClick={practice.submitPractice}
                      disabled={!practice.speech.transcript}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      답변 제출
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Comparing phase */}
          {practice.phase === 'comparing' && practice.currentAnswer && (
            <div className="space-y-4">
              {/* Practice transcript */}
              {practice.currentResult && (
                <div>
                  <p className="mb-1 text-sm font-medium text-blue-600">이번 답변</p>
                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950">
                    {practice.currentResult.practiceTranscript}
                  </div>
                </div>
              )}

              {/* Previous answer */}
              {practice.currentAnswer.answerTranscript && (
                <div>
                  <p className="mb-1 text-sm font-medium text-muted-foreground">이전 답변</p>
                  <div className="rounded-lg bg-muted/50 p-3 text-sm">
                    {practice.currentAnswer.answerTranscript}
                  </div>
                </div>
              )}

              {/* Model answer */}
              {practice.currentAnswer.modelAnswer && (
                <div>
                  <p className="mb-1 text-sm font-medium text-green-600">모범 답안</p>
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950">
                    {practice.currentAnswer.modelAnswer}
                  </div>
                </div>
              )}

              {/* AI evaluation result or button */}
              {practice.currentResult?.evaluation ? (
                <Card className="border-primary/20 bg-primary/5">
                  <CardContent className="py-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                        <span className="text-lg font-bold text-primary">
                          {practice.currentResult.evaluation.overallScore}
                        </span>
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">AI 평가 점수: {practice.currentResult.evaluation.overallScore}/100</p>
                        <p className="text-sm text-muted-foreground">
                          {practice.currentResult.evaluation.briefFeedback}
                        </p>
                      </div>
                    </div>
                    {practice.currentResult.evaluation.detailedFeedback && (
                      <p className="mt-3 text-sm">{practice.currentResult.evaluation.detailedFeedback}</p>
                    )}
                  </CardContent>
                </Card>
              ) : practice.currentResult ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={practice.requestEvaluation}
                  disabled={practice.currentResult.isEvaluating}
                >
                  {practice.currentResult.isEvaluating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      평가 중...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" />
                      AI 평가 받기
                    </>
                  )}
                </Button>
              ) : null}

              {/* Navigation */}
              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="outline"
                  onClick={practice.startPractice}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  다시 연습
                </Button>
                <Button onClick={practice.nextQuestion}>
                  {practice.currentIndex + 1 >= practice.totalQuestions ? (
                    <>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      연습 완료
                    </>
                  ) : (
                    <>
                      다음 질문
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Speech API warning */}
      {!practice.speech.isSupported && (
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
