'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { TopicSelector } from '@/components/nightly-study/topic-selector';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { MicCheckDialog } from '@/components/interview/mic-check-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Moon, Clock, FileText, BookOpen, ArrowLeft, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type StudyType = null | 'resume' | 'concept';

interface TopicKnowledge {
  topicId: string;
  topicName: string;
  proficiency: number;
  studyCount: number;
  lastScore: number;
  weakPoints: string[];
  nextReviewAt: string | null;
}

interface StudySession {
  id: string;
  createdAt: string;
  mode: string;
  questionCount: number;
  topics: string[];
  summary: { strengths?: string[]; reviewTopics?: string[] } | null;
}

interface HistoryData {
  sessions: StudySession[];
  topics: TopicKnowledge[];
}

export default function NightlyStudyPage() {
  const router = useRouter();
  const [studyType, setStudyType] = useState<StudyType>(null);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedMode, setSelectedMode] = useState<'deep' | 'light'>('deep');
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [showMicCheck, setShowMicCheck] = useState(false);

  const { data: history } = useQuery<HistoryData>({
    queryKey: ['nightly-study-history'],
    queryFn: async () => {
      const res = await fetch('/api/nightly-study/history');
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
  });

  const { data: statusData } = useQuery<{ dailyLimitReached: boolean }>({
    queryKey: ['nightly-study-status'],
    queryFn: async () => {
      const res = await fetch('/api/nightly-study/status');
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
  });

  const dailyLimitReached = statusData?.dailyLimitReached ?? false;

  const handleTopicSelect = (categories: string[], mode: 'deep' | 'light') => {
    setSelectedCategories(categories);
    setSelectedMode(mode);
    setShowMicCheck(true);
  };

  const handleMicConfirm = () => {
    setShowMicCheck(false);
    sessionStorage.setItem('nightly_study_config', JSON.stringify({
      categories: selectedCategories,
      mode: selectedMode,
      ...(studyType === 'resume' && resumeId ? { resumeId } : {}),
    }));
    router.push('/nightly-study/session');
  };

  const studiedTopics = history?.topics?.filter(t => t.studyCount > 0) ?? [];
  const recentSessions = history?.sessions ?? [];

  if (dailyLimitReached) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <div className="text-center">
          <Moon className="mx-auto h-12 w-12 text-primary/50" />
          <h1 className="mt-4 text-2xl font-bold">오늘의 학습</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <Clock className="h-10 w-10 text-muted-foreground" />
            <div className="text-center">
              <p className="text-lg font-semibold">오늘은 이미 학습했어요!</p>
              <p className="mt-1 text-sm text-muted-foreground">
                내일 다시 만나요. 매일 꾸준히 하는 게 가장 중요해요.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* 이미 학습한 날에도 토픽 현황은 보여줌 */}
        {studiedTopics.length > 0 && <TopicKnowledgeCard topics={studiedTopics} />}
        {recentSessions.length > 0 && <RecentSessionsCard sessions={recentSessions} />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="text-center">
        <Moon className="mx-auto h-12 w-12 text-primary" />
        <h1 className="mt-4 text-2xl font-bold">오늘의 학습</h1>
        <p className="mt-2 text-muted-foreground">
          자기 전 5~10분, 가볍게 기술 개념을 복습해보세요
        </p>
      </div>

      {/* Step 1: 학습 유형 선택 */}
      {studyType === null && (
        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            className={cn(
              'rounded-xl border-2 p-6 text-left transition-all',
              'hover:border-primary/50 hover:shadow-md',
            )}
            onClick={() => setStudyType('resume')}
          >
            <FileText className="mb-3 h-8 w-8 text-primary" />
            <p className="text-lg font-semibold">이력서 기반 학습</p>
            <p className="mt-1 text-sm text-muted-foreground">
              내 이력서의 기술스택에 맞춘 질문으로 면접 대비
            </p>
          </button>

          <button
            type="button"
            className={cn(
              'rounded-xl border-2 p-6 text-left transition-all',
              'hover:border-emerald-500/50 hover:shadow-md',
            )}
            onClick={() => setStudyType('concept')}
          >
            <BookOpen className="mb-3 h-8 w-8 text-emerald-500" />
            <p className="text-lg font-semibold">기초 개념 학습</p>
            <p className="mt-1 text-sm text-muted-foreground">
              CS, JavaScript, React 등 기초 개념을 주제별로 복습
            </p>
          </button>
        </div>
      )}

      {/* Step 2: 이력서 기반 */}
      {studyType === 'resume' && (
        <>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setStudyType(null)}
          >
            <ArrowLeft className="h-4 w-4" />
            돌아가기
          </button>
          <ResumeSelector selectedId={resumeId} onSelect={setResumeId} />
          {resumeId && <TopicSelector onStart={handleTopicSelect} />}
          {!resumeId && (
            <p className="text-center text-sm text-muted-foreground">
              이력서를 선택하면 주제 선택으로 넘어갑니다
            </p>
          )}
        </>
      )}

      {/* Step 2: 기초 개념 */}
      {studyType === 'concept' && (
        <>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setStudyType(null)}
          >
            <ArrowLeft className="h-4 w-4" />
            돌아가기
          </button>
          <TopicSelector onStart={handleTopicSelect} />
        </>
      )}

      {/* 내 학습 현황 — 학습 유형 미선택 상태에서만 표시 */}
      {studyType === null && studiedTopics.length > 0 && (
        <TopicKnowledgeCard topics={studiedTopics} />
      )}

      {studyType === null && recentSessions.length > 0 && (
        <RecentSessionsCard sessions={recentSessions} />
      )}

      <MicCheckDialog
        open={showMicCheck}
        onOpenChange={setShowMicCheck}
        onConfirm={handleMicConfirm}
        loading={false}
      />
    </div>
  );
}

function TopicKnowledgeCard({ topics }: { topics: TopicKnowledge[] }) {
  const sorted = [...topics].sort((a, b) => a.proficiency - b.proficiency);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">내 토픽 현황</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sorted.map((topic) => (
          <div key={topic.topicId} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{topic.topicName}</span>
                <span className="text-xs text-muted-foreground">{topic.studyCount}회 학습</span>
              </div>
              <span className={cn(
                'text-sm font-medium',
                topic.proficiency >= 60 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
              )}>
                {topic.proficiency}%
              </span>
            </div>
            <Progress value={topic.proficiency} className="h-1.5" />
            {topic.weakPoints.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {topic.weakPoints.map((wp, i) => (
                  <Badge key={i} variant="outline" className="text-xs text-amber-600 dark:text-amber-400">
                    <AlertCircle className="mr-1 h-2.5 w-2.5" />
                    {wp}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function RecentSessionsCard({ sessions }: { sessions: StudySession[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">최근 학습 기록</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sessions.slice(0, 5).map((s) => {
          const date = new Date(s.createdAt);
          const dateStr = date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
          const uniqueTopics = [...new Set(s.topics)];

          return (
            <div key={s.id} className="flex items-start justify-between rounded-lg border p-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{dateStr}</span>
                  <Badge variant="secondary" className="text-xs">
                    {s.mode === 'deep' ? '깊게' : '가볍게'} {s.questionCount}문제
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {uniqueTopics.join(', ')}
                </p>
                {s.summary && (
                  <div className="mt-1 space-y-0.5">
                    {s.summary.strengths?.slice(0, 1).map((str, i) => (
                      <p key={i} className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <CheckCircle className="h-3 w-3 shrink-0" />
                        {str}
                      </p>
                    ))}
                    {s.summary.reviewTopics?.slice(0, 1).map((str, i) => (
                      <p key={i} className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <XCircle className="h-3 w-3 shrink-0" />
                        {str}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
