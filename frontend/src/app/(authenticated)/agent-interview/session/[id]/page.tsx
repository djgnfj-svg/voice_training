'use client';

import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, ArrowLeft, CheckCircle, TrendingUp, AlertCircle, Target, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getGrade } from '@/lib/utils';
import { scoreText } from '@/lib/score-colors';
import { AgentInterviewPanel } from '@/components/agent-interview/agent-interview-panel';
import { getAgentSession } from '@/lib/agent-interview-api';

type InsightItem = string | { text: string; questionRefs?: number[] };

function InsightList({ items, tone }: { items: InsightItem[]; tone: 'positive' | 'warning' }) {
  const badgeClass = tone === 'positive'
    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';
  return (
    <ul className="space-y-2">
      {items.map((item, i) => {
        const text = typeof item === 'string' ? item : item.text;
        const refs = typeof item === 'string' ? [] : (item.questionRefs || []);
        return (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium', badgeClass)}>
              {i + 1}
            </span>
            <div className="flex-1">
              <span>{text}</span>
              {refs.length > 0 && (
                <span className="ml-2 text-xs text-muted-foreground">(Q{refs.join(', Q')})</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function AgentInterviewSessionPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const sessionId = params.id as string;
  const isNewSession = sessionId === 'new';

  const resumeId = searchParams.get('resumeId') || '';
  const jobPostingId = searchParams.get('jobPostingId') || undefined;

  const { data: session, isLoading } = useQuery({
    queryKey: ['agent-session', sessionId],
    queryFn: () => getAgentSession(sessionId),
    enabled: !isNewSession,
  });

  // New session requires resumeId
  if (isNewSession && !resumeId) {
    router.replace('/interview/setup');
    return null;
  }

  // New session — show interview panel
  if (isNewSession) {
    return (
      <AgentInterviewPanel
        resumeId={resumeId}
        jobPostingId={jobPostingId}
        onComplete={(sid) => {
          router.push(`/agent-interview/session/${sid}`);
        }}
      />
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-muted-foreground">리포트를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-8 text-center">
            <AlertCircle className="mx-auto h-10 w-10 text-destructive" />
            <p className="mt-4 text-destructive">세션을 불러올 수 없습니다</p>
            <Link href="/interview/setup">
              <Button className="mt-4">면접 설정으로 돌아가기</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const report = session.reportData;
  const messages = session.messages || [];
  const overallScore = session.overallScore || report?.overallScore || 0;
  const grade = getGrade(overallScore);

  // Extract question-answer pairs from messages
  const qaPairs: { question: string; answer: string; evaluation: Record<string, unknown> | null; questionNumber: number; followUpRound: number }[] = [];
  let currentQ = '';
  let currentQNum = 0;
  let currentFU = 0;
  for (const msg of messages) {
    if (msg.role === 'agent_question' || msg.role === 'agent_followup') {
      currentQ = msg.content;
      currentQNum = msg.questionNumber || 0;
      currentFU = msg.followUpRound || 0;
    } else if (msg.role === 'user_answer') {
      qaPairs.push({
        question: currentQ,
        answer: msg.content,
        evaluation: msg.evaluation || null,
        questionNumber: currentQNum,
        followUpRound: currentFU,
      });
    }
  }

  // Calculate average scores across all evaluations
  const allEvals = qaPairs.filter(qa => qa.evaluation && qa.answer !== '(건너뜀)').map(qa => qa.evaluation!);
  const avgScores: Record<string, number> = {};
  if (allEvals.length > 0) {
    const scoreKeys = ['clarity', 'accuracy', 'practicality', 'depth', 'completeness'];
    for (const key of scoreKeys) {
      const values = allEvals
        .map(e => (e.scores as Record<string, number>)?.[key])
        .filter((v): v is number => v != null);
      if (values.length > 0) {
        avgScores[key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      }
    }
  }

  const scoreLabels: Record<string, string> = {
    clarity: '전달력',
    accuracy: '정확성',
    practicality: '실무력',
    depth: '깊이',
    completeness: '완성도',
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/history" className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> 기록으로 돌아가기
          </Link>
          <h1 className="text-2xl font-bold md:text-3xl">AI 코치 면접 리포트</h1>
        </div>
        <Link href="/interview/setup">
          <Button>새 면접 시작</Button>
        </Link>
      </div>

      {/* Overall Score */}
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center gap-6 sm:flex-row sm:gap-12">
            <div className="text-center">
              <div className="bg-gradient-to-br from-primary to-blue-400 bg-clip-text text-5xl font-bold text-transparent sm:text-6xl">
                {overallScore}
              </div>
              <div className="mt-1 text-xl font-semibold sm:text-2xl">{grade}</div>
              <p className="text-sm text-muted-foreground">종합 점수</p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-blue-500 sm:text-4xl">
                {qaPairs.filter(qa => qa.answer !== '(건너뜀)').length}
              </div>
              <p className="text-sm text-muted-foreground">답변한 질문</p>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-emerald-500 sm:text-4xl">
                {qaPairs.filter(qa => qa.followUpRound > 0).length}
              </div>
              <p className="text-sm text-muted-foreground">꼬리질문</p>
            </div>
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
          {/* Summary */}
          {report?.summary && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5" />
                  종합 평가
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed">{report.summary}</p>
              </CardContent>
            </Card>
          )}

          {/* Technical Diagnosis */}
          {(() => {
            const td = report?.technicalDiagnosis as {
              strongTopics?: { keyword: string; evidence?: string }[];
              weakTopics?: { keyword: string; reason?: string; studyHint?: string }[];
            } | undefined;
            if (!td?.strongTopics?.length && !td?.weakTopics?.length) return null;
            return (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="h-5 w-5" />
                  기술 진단
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                    <>
                      {td.strongTopics && td.strongTopics.length > 0 && (
                        <div>
                          <div className="mb-2 text-sm font-medium text-green-600 dark:text-green-400">잘 다룬 기술</div>
                          <div className="flex flex-wrap gap-2">
                            {td.strongTopics.map((t, i) => (
                              <Badge key={i} variant="outline" className="border-green-500/40 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300">
                                {t.keyword}{t.evidence ? ` · ${t.evidence}` : ''}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      {td.weakTopics && td.weakTopics.length > 0 && (
                        <div>
                          <div className="mb-2 text-sm font-medium text-red-600 dark:text-red-400">보완이 필요한 기술</div>
                          <ul className="space-y-3">
                            {td.weakTopics.map((t, i) => (
                              <li key={i} className="rounded-md border border-red-500/20 bg-red-50/50 p-3 dark:bg-red-950/20">
                                <div className="font-medium text-red-700 dark:text-red-300">{t.keyword}</div>
                                {t.reason && <div className="mt-1 text-sm text-muted-foreground">{t.reason}</div>}
                                {t.studyHint && <div className="mt-1 text-xs text-muted-foreground">학습: {t.studyHint}</div>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
              </CardContent>
            </Card>
            );
          })()}

          {/* Question Highlights */}
          {(() => {
            const qh = report?.questionHighlights as { best?: { qIdx: number; reason: string }; worst?: { qIdx: number; reason: string } } | undefined;
            if (!qh?.best && !qh?.worst) return null;
            return (
              <Card>
                <CardHeader>
                  <CardTitle>질문별 하이라이트</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  {qh.best && (
                    <div className="rounded-md border border-green-500/30 bg-green-50/50 p-3 dark:bg-green-950/20">
                      <div className="text-xs font-medium text-green-600 dark:text-green-400">최고 답변 · Q{qh.best.qIdx}</div>
                      <div className="mt-1 text-sm">{qh.best.reason}</div>
                    </div>
                  )}
                  {qh.worst && (
                    <div className="rounded-md border border-red-500/30 bg-red-50/50 p-3 dark:bg-red-950/20">
                      <div className="text-xs font-medium text-red-600 dark:text-red-400">개선 필요 · Q{qh.worst.qIdx}</div>
                      <div className="mt-1 text-sm">{qh.worst.reason}</div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          {/* Phase Insight */}
          {(report?.phaseInsight || report?.phaseAnalysis) && (
            <Card>
              <CardHeader>
                <CardTitle>페이즈별 분석</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {report?.phaseInsight && <p className="text-sm leading-relaxed">{report.phaseInsight as string}</p>}
                {report?.phaseAnalysis && (
                  <div className="grid grid-cols-2 gap-3">
                    {(['scan', 'dive'] as const).map((k) => {
                      const pa = report.phaseAnalysis as Record<string, { avg: number; count: number }>;
                      const p = pa[k];
                      if (!p || p.count === 0) return null;
                      return (
                        <div key={k} className="rounded-md border bg-muted/30 p-3">
                          <div className="text-xs text-muted-foreground">{k === 'scan' ? '훑기' : '딥다이브'}</div>
                          <div className={cn('text-2xl font-bold', scoreText(p.avg))}>{p.avg}</div>
                          <div className="text-xs text-muted-foreground">{p.count}개 답변</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Average Scores */}
          {Object.keys(avgScores).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>역량별 평균 점수</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 sm:grid-cols-5">
                  {Object.entries(avgScores).map(([key, value]) => (
                    <div key={key} className="text-center">
                      <div className={cn('text-2xl font-bold', scoreText(value))}>
                        {value}
                      </div>
                      <div className="text-xs text-muted-foreground">{scoreLabels[key] || key}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Strengths */}
          {report?.strengths?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  강점
                </CardTitle>
              </CardHeader>
              <CardContent>
                <InsightList items={report.strengths as InsightItem[]} tone="positive" />
              </CardContent>
            </Card>
          )}

          {/* Growth Notes */}
          {report?.growthNotes && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-blue-500" />
                  성장 노트
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm">{report.growthNotes}</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Questions Detail Tab */}
        <TabsContent value="questions" className="space-y-4">
          {qaPairs.map((qa, i) => (
            <Card key={i}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">
                    Q{qa.questionNumber}.
                    {qa.followUpRound > 0 && (
                      <Badge variant="outline" className="ml-2 text-xs">꼬리질문 {qa.followUpRound}</Badge>
                    )}
                  </CardTitle>
                  {qa.evaluation && (
                    <Badge
                      variant={
                        (qa.evaluation.overallScore as number) >= 70 ? 'default' :
                        (qa.evaluation.overallScore as number) >= 50 ? 'secondary' : 'destructive'
                      }
                    >
                      {qa.evaluation.overallScore as number}점
                    </Badge>
                  )}
                </div>
                <CardDescription className="mt-1">{qa.question}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Answer */}
                <div>
                  <p className="mb-1 text-sm font-medium text-muted-foreground">내 답변</p>
                  <div className="rounded-lg bg-muted/50 p-3 text-sm">
                    {qa.answer === '(건너뜀)' ? (
                      <span className="text-muted-foreground italic">건너뜀</span>
                    ) : qa.answer}
                  </div>
                </div>

                {qa.evaluation && qa.answer !== '(건너뜀)' && (
                  <>
                    {/* Scores */}
                    {(qa.evaluation.scores as Record<string, number>) && (
                      <div>
                        <p className="mb-2 text-sm font-medium text-muted-foreground">점수 상세</p>
                        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                          {Object.entries(qa.evaluation.scores as Record<string, number>).map(([key, value]) => (
                            <div key={key} className="text-center">
                              <div className="text-lg font-bold">{value}</div>
                              <div className="text-xs text-muted-foreground">{scoreLabels[key] || key}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Demonstrated Keywords */}
                    {Array.isArray(qa.evaluation.demonstratedKeywords) && (qa.evaluation.demonstratedKeywords as string[]).length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-medium text-muted-foreground">답변에서 다룬 기술</p>
                        <div className="flex flex-wrap gap-1">
                          {(qa.evaluation.demonstratedKeywords as string[]).map((kw, idx) => (
                            <Badge key={idx} variant="outline" className="border-green-500/40 bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300">
                              {kw}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Missing Keywords */}
                    {Array.isArray(qa.evaluation.missingKeywords) && (qa.evaluation.missingKeywords as string[]).length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-medium text-muted-foreground">빠진 핵심 개념</p>
                        <div className="flex flex-wrap gap-1">
                          {(qa.evaluation.missingKeywords as string[]).map((kw, idx) => (
                            <Badge key={idx} variant="outline" className="border-red-500/40 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300">
                              {kw}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Feedback */}
                    {(qa.evaluation.detailedFeedback as string) && (
                      <div>
                        <p className="mb-1 text-sm font-medium text-muted-foreground">피드백</p>
                        <p className="text-sm">{qa.evaluation.detailedFeedback as string}</p>
                      </div>
                    )}

                    {/* Model answer */}
                    {(qa.evaluation.modelAnswer as string) && (
                      <div>
                        <p className="mb-1 text-sm font-medium text-muted-foreground">모범 답안</p>
                        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950">
                          {qa.evaluation.modelAnswer as string}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* Improvement Tab */}
        <TabsContent value="improvement" className="space-y-4">
          {report?.improvements?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-orange-500" />
                  개선점
                </CardTitle>
              </CardHeader>
              <CardContent>
                <InsightList items={report.improvements as InsightItem[]} tone="warning" />
              </CardContent>
            </Card>
          )}

          {report?.recommendations?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-blue-500" />
                  추천 학습
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {report.recommendations.map((item: string, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        {i + 1}
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
