'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { JobPostingInput, JobPostingResult } from '@/components/job-posting/job-posting-input';
import { useToast } from '@/hooks/useToast';
import { Sparkles, ArrowRight, SkipForward, PlayCircle, BookOpen, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InsufficientCreditsDialog } from '@/components/credit/insufficient-credits-dialog';
import { MicCheckDialog } from '@/components/interview/mic-check-dialog';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';

type Step = 'resume' | 'job-posting' | 'start';
type InterviewMode = 'ai-coach' | 'model-answer';

export default function InterviewSetupPage() {
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

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">면접 시작</h1>
        <p className="text-muted-foreground">
          이력서를 선택하고, 선택적으로 채용 공고를 입력하면 AI가 맞춤 면접을 진행합니다.
        </p>
      </div>

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
                {/* AI 코치 모드 */}
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

                {/* 모범답안 학습 모드 */}
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
    </div>
  );
}
