'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScoreRadarChart } from '@/components/report/radar-chart';
import { Loader2, ArrowLeft, Target, TrendingUp, AlertCircle, CheckCircle, Clock, RotateCcw, Play } from 'lucide-react';
import { getGrade } from '@/lib/utils';
import type { InterviewReport } from '@/types';

export default function ReportPage() {
  const params = useParams();
  const sessionId = params.id as string;

  const { data: report, isLoading, error } = useQuery<InterviewReport>({
    queryKey: ['report', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/interview/${sessionId}/report`);
      if (!res.ok) throw new Error('Failed to load report');
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-muted-foreground">리포트를 생성하고 있습니다...</p>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-8 text-center">
            <AlertCircle className="mx-auto h-10 w-10 text-destructive" />
            <p className="mt-4 text-destructive">리포트를 불러올 수 없습니다</p>
            <Link href="/dashboard">
              <Button className="mt-4">대시보드로 돌아가기</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/history" className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> 기록으로 돌아가기
          </Link>
          <h1 className="text-2xl font-bold md:text-3xl">면접 리포트</h1>
        </div>
        <div className="flex gap-2">
          <Link href={`/interview/practice/${sessionId}`}>
            <Button variant="outline">
              <RotateCcw className="mr-2 h-4 w-4" />
              다시 연습하기
            </Button>
          </Link>
          <Link href="/interview/setup">
            <Button>새 면접 시작</Button>
          </Link>
        </div>
      </div>

      {/* Overall Score */}
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center gap-6 sm:flex-row sm:gap-8">
            <div className="text-center">
              <div className="bg-gradient-to-br from-primary to-blue-400 bg-clip-text text-5xl font-bold text-transparent sm:text-6xl">{report.overallScore}</div>
              <div className="mt-1 text-xl font-semibold sm:text-2xl">{report.grade}</div>
              <p className="text-sm text-muted-foreground">종합 점수</p>
            </div>
            {report.matchingScore !== undefined && (
              <div className="text-center">
                <div className="text-3xl font-bold text-blue-500 dark:text-blue-400 sm:text-4xl">{report.matchingScore}%</div>
                <p className="text-sm text-muted-foreground">공고 매칭도</p>
              </div>
            )}
            {report.speechAnalysis && (
              <div className="text-center">
                <div className="flex items-center gap-1 text-3xl font-bold text-green-500 dark:text-green-400 sm:text-4xl">
                  <Clock className="h-6 w-6 sm:h-8 sm:w-8" />
                  {report.speechAnalysis.averageResponseTime}초
                </div>
                <p className="text-sm text-muted-foreground">평균 응답 시간</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="overview">종합 분석</TabsTrigger>
          <TabsTrigger value="questions">질문별 상세</TabsTrigger>
          <TabsTrigger value="improvement">개선점</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          {/* Radar Chart */}
          <Card>
            <CardHeader>
              <CardTitle>역량 분석</CardTitle>
            </CardHeader>
            <CardContent>
              <ScoreRadarChart answers={report.answers} />
            </CardContent>
          </Card>

          {/* Strengths */}
          {report.strengths.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  강점 Top 3
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {report.strengths.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-green-100 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        {i + 1}
                      </span>
                      {s}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Gap Analysis */}
          {report.gapAnalysis && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-blue-500" />
                  공고 매칭 분석
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span>커버리지</span>
                    <span className="font-medium">{report.gapAnalysis.coveragePercentage}%</span>
                  </div>
                  <Progress value={report.gapAnalysis.coveragePercentage} />
                </div>
                {report.gapAnalysis.missingSkills.length > 0 && (
                  <div>
                    <p className="mb-2 text-sm font-medium">부족한 기술 영역</p>
                    <div className="flex flex-wrap gap-2">
                      {report.gapAnalysis.missingSkills.map((skill, i) => (
                        <Badge key={i} variant="destructive">{skill}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Questions Detail Tab */}
        <TabsContent value="questions" className="space-y-4">
          {report.answers.map((answer) => (
            <Card key={answer.questionIndex}>
              <CardHeader>
                <div className="flex items-start gap-2">
                  <CardTitle className="text-base">
                    Q{answer.questionIndex + 1}. {answer.questionText}
                  </CardTitle>
                  <Badge
                    className="shrink-0"
                    variant={answer.overallScore >= 70 ? 'default' : answer.overallScore >= 50 ? 'secondary' : 'destructive'}
                  >
                    {answer.overallScore}점
                  </Badge>
                </div>
                <CardDescription>
                  <Badge variant="outline" className="mr-2">
                    {answer.questionSource === 'job_posting' ? '공고 맞춤' : answer.questionSource === 'resume_based' ? '이력서 기반' : '일반'}
                  </Badge>
                  {answer.responseTimeSec && `응답 시간: ${answer.responseTimeSec}초`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Answer transcript */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-sm font-medium text-muted-foreground">내 답변</p>
                    {answer.audioUrl && (
                      <button
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                        onClick={() => {
                          const audio = new Audio(answer.audioUrl);
                          audio.play();
                        }}
                      >
                        <Play className="h-3 w-3" />
                        녹음 재생
                      </button>
                    )}
                  </div>
                  <div className="rounded-lg bg-muted/50 p-3 text-sm">
                    {answer.answerTranscript || '(답변 없음)'}
                  </div>
                </div>

                {/* Scores */}
                <div>
                  <p className="mb-2 text-sm font-medium text-muted-foreground">점수 상세</p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {Object.entries(answer.scores).map(([key, value]) => {
                      const labels: Record<string, string> = {
                        accuracy: '정확성',
                        depth: '깊이',
                        clarity: '명확성',
                        completeness: '완성도',
                        practicality: '실무력',
                      };
                      return (
                        <div key={key} className="text-center">
                          <div className="text-lg font-bold">{value as number}</div>
                          <div className="text-xs text-muted-foreground">{labels[key] || key}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Feedback */}
                <div>
                  <p className="mb-1 text-sm font-medium text-muted-foreground">피드백</p>
                  <p className="text-sm">{answer.detailedFeedback}</p>
                </div>

                {/* Model answer */}
                <div>
                  <p className="mb-1 text-sm font-medium text-muted-foreground">모범 답안</p>
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950">
                    {answer.modelAnswer}
                  </div>
                </div>

                {/* Follow-up question */}
                {answer.followUpQuestion && (
                  <div>
                    <p className="mb-1 text-sm font-medium text-muted-foreground">꼬리질문</p>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
                      {answer.followUpQuestion}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* Improvement Tab */}
        <TabsContent value="improvement" className="space-y-4">
          {report.improvements.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-orange-500" />
                  개선점 Top 3
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {report.improvements.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-orange-100 text-xs font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                        {i + 1}
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {report.speechAnalysis && (
            <Card>
              <CardHeader>
                <CardTitle>발화 분석</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">평균 응답 시간</span>
                  <span className="font-medium">{report.speechAnalysis.averageResponseTime}초</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">발화 속도</span>
                  <div className="flex items-center gap-2">
                    {report.speechAnalysis.averageWpm && (
                      <span className="text-sm font-medium">{report.speechAnalysis.averageWpm}음절/분</span>
                    )}
                    <Badge variant="outline" className={
                      report.speechAnalysis.speechRate === '적정' ? 'border-green-300 text-green-700 dark:border-green-800 dark:text-green-400' :
                      report.speechAnalysis.speechRate === '느림' ? 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400' :
                      'border-red-300 text-red-700 dark:border-red-800 dark:text-red-400'
                    }>{report.speechAnalysis.speechRate}</Badge>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">필러워드</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{report.speechAnalysis.fillerWordCount}회</span>
                    <Badge variant="outline" className={
                      report.speechAnalysis.fillerWordCount <= 5 ? 'border-green-300 text-green-700 dark:border-green-800 dark:text-green-400' :
                      report.speechAnalysis.fillerWordCount <= 15 ? 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400' :
                      'border-red-300 text-red-700 dark:border-red-800 dark:text-red-400'
                    }>
                      {report.speechAnalysis.fillerWordCount <= 5 ? '양호' :
                       report.speechAnalysis.fillerWordCount <= 15 ? '주의' : '많음'}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
