'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { JobPostingInput, JobPostingResult } from '@/components/job-posting/job-posting-input';
import { useToast } from '@/hooks/useToast';
import {
  Sparkles, ArrowRight, SkipForward, PlayCircle, BookOpen, Bot,
  Mic, Upload, FileText, CheckCircle, Loader2, Trash2, Pencil,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { cn, formatDate } from '@/lib/utils';
import { InsufficientCreditsDialog } from '@/components/credit/insufficient-credits-dialog';
import { MicCheckDialog } from '@/components/interview/mic-check-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { ParsedJobPosting, CompanyAnalysis, ParsedResume } from '@/types';

// ── Types ──

type Step = 'resume' | 'job-posting' | 'start';
type InterviewMode = 'ai-coach' | 'model-answer';

interface SessionItem {
  _kind: 'session';
  id: string;
  type: string;
  categories?: string[] | null;
  status: string;
  overallScore: number | null;
  createdAt: string;
  resumeName?: string | null;
  jobPostingData?: ParsedJobPosting | null;
  answerCount: number;
}

interface ActivityItem {
  _kind: 'activity';
  id: string;
  type: 'MODEL_ANSWER';
  resumeId: string | null;
  createdAt: string;
  resumeName?: string | null;
  itemCount: number;
}

type HistoryItem = SessionItem | ActivityItem;

interface ResumeListItem {
  id: string;
  name: string;
  parsedData: ParsedResume | null;
  createdAt: string;
}

// ── Page ──

export default function InterviewSetupPage() {
  const searchParams = useSearchParams();
  const defaultTab = searchParams.get('tab') === 'resume' ? 'resume' : 'interview';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">면접 연습</h1>
        <p className="text-muted-foreground">
          이력서를 관리하고, AI 맞춤 면접을 연습하세요
        </p>
      </div>

      <Tabs defaultValue={defaultTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="interview" className="gap-2">
            <Mic className="h-4 w-4" />
            면접
          </TabsTrigger>
          <TabsTrigger value="resume" className="gap-2">
            <FileText className="h-4 w-4" />
            이력서 관리
          </TabsTrigger>
        </TabsList>

        <TabsContent value="interview" className="space-y-6">
          <InterviewTab />
        </TabsContent>

        <TabsContent value="resume" className="space-y-6">
          <ResumeTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Interview Tab ──

function InterviewTab() {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('resume');

  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [interviewMode, setInterviewMode] = useState<InterviewMode>('ai-coach');
  const [maxQuestions, setMaxQuestions] = useState('7');
  const [showCreditsDialog, setShowCreditsDialog] = useState(false);
  const [showMicCheck, setShowMicCheck] = useState(false);
  const [jobPostingData, setJobPostingData] = useState<{
    id: string;
    rawText: string;
    parsedData: ParsedJobPosting;
    companyAnalysis: CompanyAnalysis;
    deepResearchAvailable: boolean;
  } | null>(null);
  const [inProgressSession, setInProgressSession] = useState<{
    id: string;
    type: string;
    totalQuestions: number;
    answeredCount: number;
  } | null>(null);

  useEffect(() => {
    fetch('/api/interview/in-progress')
      .then((res) => res.json())
      .then((data) => {
        if (data.session) setInProgressSession(data.session);
      })
      .catch(() => {});
  }, []);

  const { data: historyItems } = useQuery<HistoryItem[]>({
    queryKey: ['history'],
    queryFn: async () => {
      const res = await fetch('/api/history');
      if (!res.ok) throw new Error('Failed to load history');
      return res.json();
    },
  });

  const goToJobPosting = () => {
    if (!selectedResumeId) {
      toast({ title: '이력서를 선택해주세요', variant: 'destructive' });
      return;
    }
    setStep('job-posting');
  };

  const skipJobPosting = () => {
    setStep('start');
  };

  const handleJobPostingAnalyzed = (data: {
    id: string;
    rawText: string;
    parsedData: ParsedJobPosting;
    companyAnalysis: CompanyAnalysis;
    deepResearchAvailable: boolean;
  }) => {
    setJobPostingData(data);
    setStep('start');
  };

  const startInterview = () => {
    if (!selectedResumeId) {
      toast({ title: '이력서를 선택해주세요', variant: 'destructive' });
      return;
    }

    if (interviewMode === 'ai-coach') {
      setShowMicCheck(true);
      return;
    }

    if (interviewMode === 'model-answer') {
      if (jobPostingData?.rawText) {
        sessionStorage.setItem('model_answer_job_posting', jobPostingData.rawText);
      } else {
        sessionStorage.removeItem('model_answer_job_posting');
      }
      router.push(`/interview/model-answer/${selectedResumeId}`);
      return;
    }
  };

  const typeLabels: Record<string, string> = {
    TECHNICAL: '기술면접',
    BEHAVIORAL: '인성면접',
    MIXED: '혼합면접',
  };

  const statusLabels: Record<string, string> = {
    IN_PROGRESS: '진행 중',
    COMPLETED: '완료',
    ABANDONED: '중단',
  };

  return (
    <>
      {/* In-progress session banner */}
      {inProgressSession && (
        <div className="flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <div className="space-y-1">
            <p className="font-medium text-amber-800 dark:text-amber-200">
              진행 중인 면접이 있습니다
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {inProgressSession.answeredCount}/{inProgressSession.totalQuestions}문항 답변 완료
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900"
            onClick={() => router.push(`/interview/session/${inProgressSession.id}`)}
          >
            <PlayCircle className="mr-2 h-4 w-4" />
            이어하기
          </Button>
        </div>
      )}

      {/* Step indicators */}
      <div className="flex items-center gap-3 text-sm">
        {[
          { key: 'resume' as const, label: '이력서 선택' },
          { key: 'job-posting' as const, label: '채용공고' },
          { key: 'start' as const, label: '면접 시작' },
        ].map((s, i, arr) => {
          const steps: Step[] = ['resume', 'job-posting', 'start'];
          const currentIdx = steps.indexOf(step);
          return (
            <div key={s.key} className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors',
                  step === s.key
                    ? 'bg-primary text-primary-foreground'
                    : currentIdx > i
                      ? 'bg-primary/20 text-primary'
                      : 'bg-muted text-muted-foreground'
                )}>
                  {i + 1}
                </div>
                <span className={step === s.key ? 'font-semibold text-primary' : 'text-muted-foreground'}>
                  {s.label}
                </span>
              </div>
              {i < arr.length - 1 && (
                <div className={cn('h-px w-8', currentIdx > i ? 'bg-primary/40' : 'bg-border')} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1: Resume Selection */}
      {step === 'resume' && (
        <>
          <ResumeSelector
            selectedId={selectedResumeId}
            onSelect={setSelectedResumeId}
          />
          <Button
            size="lg"
            className="w-full"
            onClick={goToJobPosting}
            disabled={!selectedResumeId}
          >
            다음: 채용공고 입력
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </>
      )}

      {/* Step 2: Job Posting (optional) */}
      {step === 'job-posting' && (
        <>
          {!jobPostingData ? (
            <>
              <JobPostingInput onAnalyzed={handleJobPostingAnalyzed} />
              <Button
                variant="outline"
                size="lg"
                className="w-full"
                onClick={skipJobPosting}
              >
                <SkipForward className="mr-2 h-4 w-4" />
                건너뛰기 (이력서만으로 면접 진행)
              </Button>
            </>
          ) : (
            <JobPostingResult
              jobPostingId={jobPostingData.id}
              parsedData={jobPostingData.parsedData}
              companyAnalysis={jobPostingData.companyAnalysis}
              deepResearchAvailable={jobPostingData.deepResearchAvailable}
              onCompanyAnalysisUpdate={(analysis) =>
                setJobPostingData(prev => prev ? { ...prev, companyAnalysis: analysis } : prev)
              }
            />
          )}
        </>
      )}

      {/* Step 3: Start Interview */}
      {step === 'start' && (
        <>
          {jobPostingData && (
            <JobPostingResult
              jobPostingId={jobPostingData.id}
              parsedData={jobPostingData.parsedData}
              companyAnalysis={jobPostingData.companyAnalysis}
              deepResearchAvailable={jobPostingData.deepResearchAvailable}
              onCompanyAnalysisUpdate={(analysis) =>
                setJobPostingData(prev => prev ? { ...prev, companyAnalysis: analysis } : prev)
              }
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                면접 모드
              </CardTitle>
              <CardDescription>면접 유형을 선택하세요</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  className={cn(
                    'rounded-lg border p-4 text-left transition-all',
                    interviewMode === 'ai-coach'
                      ? 'border-blue-500 ring-2 ring-blue-500/20 bg-blue-50 dark:bg-blue-950/30'
                      : 'hover:border-muted-foreground/50'
                  )}
                  onClick={() => setInterviewMode('ai-coach')}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Bot className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-semibold">AI 코치 면접</span>
                  </div>
                  <p className="text-xs text-muted-foreground">맞춤형 동적 질문, 꼬리질문, 프로필 기억</p>
                </button>

                <button
                  type="button"
                  className={cn(
                    'rounded-lg border p-4 text-left transition-all',
                    interviewMode === 'model-answer'
                      ? 'border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-50 dark:bg-emerald-950/30'
                      : 'hover:border-muted-foreground/50'
                  )}
                  onClick={() => setInterviewMode('model-answer')}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <BookOpen className="h-4 w-4 text-emerald-500" />
                    <span className="text-sm font-semibold">모범답안 학습</span>
                  </div>
                  <p className="text-xs text-muted-foreground">모범답안 보며 학습</p>
                </button>
              </div>

              {interviewMode === 'ai-coach' && (
                <>
                  <div className="mt-3 rounded-lg bg-blue-50 p-3 dark:bg-blue-950/30">
                    <ul className="space-y-1 text-sm text-blue-700 dark:text-blue-300">
                      <li>- AI가 당신의 강점/약점을 기억하고 맞춤 질문</li>
                      <li>- 답변 깊이에 따라 꼬리질문 자동 생성 (최대 2회)</li>
                      <li>- 면접할수록 더 정확한 피드백</li>
                    </ul>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    <Label className="text-sm">질문 수</Label>
                    <Select value={maxQuestions} onValueChange={setMaxQuestions}>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 3, 5, 7, 10].map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}개{n === 1 ? ' (테스트)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              {interviewMode === 'model-answer' && (
                <div className="mt-3 rounded-lg bg-emerald-50 p-3 dark:bg-emerald-950/30">
                  <ul className="space-y-1 text-sm text-emerald-700 dark:text-emerald-300">
                    <li>- AI가 예상 질문과 모범답안을 함께 생성</li>
                    <li>- 질문을 보고 먼저 음성으로 답변 연습</li>
                    <li>- 모범답안을 공개하여 비교하고 학습</li>
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <Button
            size="lg"
            className="w-full"
            onClick={startInterview}
          >
            {interviewMode === 'ai-coach' ? (
              <>
                <Bot className="mr-2 h-4 w-4" />
                AI 코치 면접 시작
              </>
            ) : (
              <>
                <BookOpen className="mr-2 h-4 w-4" />
                모범답안 학습 시작
              </>
            )}
          </Button>
        </>
      )}

      {/* Interview History (inline) */}
      {historyItems && historyItems.length > 0 && (
        <InterviewHistorySection items={historyItems} typeLabels={typeLabels} statusLabels={statusLabels} />
      )}

      <MicCheckDialog
        open={showMicCheck}
        onOpenChange={setShowMicCheck}
        onConfirm={() => {
          setShowMicCheck(false);
          const params = new URLSearchParams({
            resumeId: selectedResumeId!,
            ...(jobPostingData?.id ? { jobPostingId: jobPostingData.id } : {}),
            maxQuestions,
          });
          router.push(`/agent-interview/session/new?${params}`);
        }}
        loading={false}
      />
      <InsufficientCreditsDialog open={showCreditsDialog} onOpenChange={setShowCreditsDialog} />
    </>
  );
}

// ── History Cards ──

function SessionCard({
  session,
  typeLabels,
  statusLabels,
}: {
  session: SessionItem;
  typeLabels: Record<string, string>;
  statusLabels: Record<string, string>;
}) {
  return (
    <Card className="transition-colors hover:bg-accent/50">
      <Link href={
        session.status === 'COMPLETED'
          ? `/interview/practice/${session.id}`
          : `/interview/session/${session.id}`
      }>
        <CardContent className="flex items-center justify-between py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{typeLabels[session.type] || session.type}</span>
              <Badge variant={session.status === 'COMPLETED' ? 'default' : 'secondary'}>
                {statusLabels[session.status] || session.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {session.resumeName && <>{session.resumeName} | </>}
              {(session.categories ?? []).join(', ')}{(session.categories ?? []).length > 0 && ' | '}{session.answerCount}문제 | {formatDate(session.createdAt)}
            </p>
            {session.jobPostingData && (
              <p className="text-xs text-muted-foreground">
                {session.jobPostingData.company} - {session.jobPostingData.position}
              </p>
            )}
          </div>
          <div className="text-right">
            {session.overallScore !== null ? (
              <p className="text-2xl font-bold">{Math.round(session.overallScore)}점</p>
            ) : (
              <p className="text-sm text-muted-foreground">-</p>
            )}
          </div>
        </CardContent>
      </Link>
    </Card>
  );
}

function ActivityCard({ activity }: { activity: ActivityItem }) {
  return (
    <Card className="transition-colors hover:bg-accent/50">
      <Link href={`/history/activity/${activity.id}`}>
        <CardContent className="flex items-center justify-between py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-emerald-500" />
              <span className="font-medium">모범답안 학습</span>
              <Badge variant="outline">모범답안</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {activity.resumeName && <>{activity.resumeName} | </>}
              {activity.itemCount}개 질문 | {formatDate(activity.createdAt)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">복습하기</p>
          </div>
        </CardContent>
      </Link>
    </Card>
  );
}

// ── Interview History Section ──

const HISTORY_PREVIEW_COUNT = 5;

function InterviewHistorySection({
  items,
  typeLabels,
  statusLabels,
}: {
  items: HistoryItem[];
  typeLabels: Record<string, string>;
  statusLabels: Record<string, string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, HISTORY_PREVIEW_COUNT);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">면접 기록</h2>
      {visible.map((item) =>
        item._kind === 'session' ? (
          <SessionCard key={`s-${item.id}`} session={item} typeLabels={typeLabels} statusLabels={statusLabels} />
        ) : (
          <ActivityCard key={`a-${item.id}`} activity={item} />
        )
      )}
      {!showAll && items.length > HISTORY_PREVIEW_COUNT && (
        <Button variant="outline" className="w-full" onClick={() => setShowAll(true)}>
          더보기 ({items.length - HISTORY_PREVIEW_COUNT}건)
        </Button>
      )}
    </div>
  );
}

// ── Resume Tab ──

function ResumeTab() {
  const [isDragging, setIsDragging] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: resumes, isLoading } = useQuery<ResumeListItem[]>({
    queryKey: ['resumes-full'],
    queryFn: async () => {
      const res = await fetch('/api/resume?detail=true');
      if (!res.ok) throw new Error('Failed to fetch resumes');
      const items = await res.json();
      return items.map((item: ResumeListItem) => ({
        id: item.id,
        name: item.name,
        parsedData: item.parsedData ?? null,
        createdAt: item.createdAt,
      }));
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/resume', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Upload failed');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes-full'] });
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      toast({ title: '이력서가 업로드되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '업로드 실패', description: error.message, variant: 'destructive' });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await fetch(`/api/resume/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Rename failed');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes-full'] });
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      setRenamingId(null);
      toast({ title: '이름이 변경되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '이름 변경 실패', description: error.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/resume/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Delete failed');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes-full'] });
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      toast({ title: '이력서가 삭제되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '삭제 실패', description: error.message, variant: 'destructive' });
    },
  });

  const handleFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith('.pdf')) {
        toast({ title: 'PDF 파일만 업로드 가능합니다', variant: 'destructive' });
        return;
      }
      uploadMutation.mutate(file);
    },
    [uploadMutation, toast]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const submitRename = (id: string) => {
    if (renameValue.trim()) {
      renameMutation.mutate({ id, name: renameValue.trim() });
    }
  };

  return (
    <>
      {/* Upload Area */}
      <Card>
        <CardHeader>
          <CardTitle>새 이력서 업로드</CardTitle>
          <CardDescription>PDF 형식의 이력서를 업로드해주세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 md:p-12 transition-colors ${
              isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            {uploadMutation.isPending ? (
              <>
                <Loader2 className="mb-4 h-10 w-10 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">이력서를 분석하고 있습니다...</p>
              </>
            ) : (
              <>
                <Upload className="mb-4 h-10 w-10 text-muted-foreground" />
                <p className="mb-2 text-sm font-medium">PDF 파일을 드래그하거나 클릭하여 업로드</p>
                <p className="text-xs text-muted-foreground">최대 10MB</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                    e.target.value = '';
                  }}
                />
                <Button variant="outline" className="mt-4" onClick={() => fileInputRef.current?.click()}>
                  파일 선택
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Resume List */}
      {isLoading ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : resumes && resumes.length > 0 ? (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">내 이력서 ({resumes.length}개)</h2>
          {resumes.map((resume) => {
            const parsed = resume.parsedData;
            const isExpanded = expandedId === resume.id;

            return (
              <Card key={resume.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-5 w-5 text-green-500" />
                      {renamingId === resume.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') submitRename(resume.id);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            className="h-8 w-32 sm:w-48"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => submitRename(resume.id)}
                            disabled={renameMutation.isPending}
                          >
                            저장
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRenamingId(null)}
                          >
                            취소
                          </Button>
                        </div>
                      ) : (
                        <CardTitle className="text-base">{resume.name}</CardTitle>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="mr-2 text-xs text-muted-foreground">
                        {new Date(resume.createdAt).toLocaleDateString('ko-KR')}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startRename(resume.id, resume.name)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>이력서를 삭제하시겠습니까?</AlertDialogTitle>
                            <AlertDialogDescription>
                              삭제된 이력서는 복구할 수 없습니다.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>취소</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteMutation.mutate(resume.id)}>
                              삭제
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpandedId(isExpanded ? null : resume.id)}
                      >
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {parsed?.skills && parsed.skills.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {parsed.skills.slice(0, 8).map((skill) => (
                        <Badge key={skill} variant="secondary" className="text-xs">
                          {skill}
                        </Badge>
                      ))}
                      {parsed.skills.length > 8 && (
                        <Badge variant="outline" className="text-xs">
                          +{parsed.skills.length - 8}
                        </Badge>
                      )}
                    </div>
                  )}
                </CardHeader>

                {isExpanded && parsed && (
                  <CardContent className="space-y-6 border-t pt-4">
                    {parsed.name && (
                      <div>
                        <h3 className="mb-1 text-sm font-medium text-muted-foreground">이름</h3>
                        <p className="font-medium">{parsed.name}</p>
                      </div>
                    )}
                    {parsed.skills && parsed.skills.length > 0 && (
                      <div>
                        <h3 className="mb-2 text-sm font-medium text-muted-foreground">기술 스택</h3>
                        <div className="flex flex-wrap gap-2">
                          {parsed.skills.map((skill) => (
                            <Badge key={skill} variant="secondary">{skill}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {parsed.experience && parsed.experience.length > 0 && (
                      <div>
                        <h3 className="mb-2 text-sm font-medium text-muted-foreground">경력</h3>
                        <div className="space-y-3">
                          {parsed.experience.map((exp, i) => (
                            <div key={i} className="rounded-lg border p-3">
                              <p className="font-medium">{exp.company} - {exp.position}</p>
                              <p className="text-sm text-muted-foreground">{exp.period}</p>
                              <p className="mt-1 text-sm">{exp.description}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {parsed.projects && parsed.projects.length > 0 && (
                      <div>
                        <h3 className="mb-2 text-sm font-medium text-muted-foreground">프로젝트</h3>
                        <div className="space-y-3">
                          {parsed.projects.map((proj, i) => (
                            <div key={i} className="rounded-lg border p-3">
                              <p className="font-medium">{proj.name}</p>
                              <p className="mt-1 text-sm">{proj.description}</p>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {proj.techStack.map((tech) => (
                                  <Badge key={tech} variant="outline" className="text-xs">{tech}</Badge>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <FileText className="mx-auto mb-4 h-10 w-10" />
            <p>아직 이력서가 등록되지 않았습니다</p>
            <p className="text-sm">위에서 PDF 이력서를 업로드해주세요</p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
