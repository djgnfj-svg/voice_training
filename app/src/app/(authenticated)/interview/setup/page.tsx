'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { JobPostingInput, JobPostingResult } from '@/components/job-posting/job-posting-input';
import { useToast } from '@/hooks/useToast';
import { Loader2, Mic, Sparkles, ArrowRight, SkipForward, FlaskConical, PlayCircle, Layers, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InsufficientCreditsDialog } from '@/components/credit/insufficient-credits-dialog';
import { isSpeechRecognitionSupported } from '@/lib/utils';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';

type Step = 'resume' | 'job-posting' | 'start';

export default function InterviewSetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('resume');

  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [interviewMode, setInterviewMode] = useState<'standard' | 'deep' | 'system_design'>('standard');
  const [showCreditsDialog, setShowCreditsDialog] = useState(false);
  const [jobPostingData, setJobPostingData] = useState<{
    id: string;
    parsedData: ParsedJobPosting;
    companyAnalysis: CompanyAnalysis;
    deepResearchAvailable: boolean;
  } | null>(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [inProgressSession, setInProgressSession] = useState<{
    id: string;
    type: string;
    totalQuestions: number;
    answeredCount: number;
  } | null>(null);

  useEffect(() => {
    setSpeechSupported(isSpeechRecognitionSupported());
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
    parsedData: ParsedJobPosting;
    companyAnalysis: CompanyAnalysis;
    deepResearchAvailable: boolean;
  }) => {
    setJobPostingData(data);
    setStep('start');
  };

  const startInterview = async () => {
    if (!selectedResumeId) {
      toast({ title: '이력서를 선택해주세요', variant: 'destructive' });
      return;
    }

    if (!isSpeechRecognitionSupported()) {
      toast({
        title: '음성 인식을 지원하지 않는 브라우저입니다',
        description: 'Chrome 또는 Edge를 사용해주세요.',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/interview/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeId: selectedResumeId,
          jobPostingId: jobPostingData?.id,
          mode: interviewMode,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        if (res.status === 402) {
          setShowCreditsDialog(true);
          return;
        }
        throw new Error(data.error || 'Setup failed');
      }

      const data = await res.json();
      const { sessionId, plan, questions } = data;

      sessionStorage.setItem(`interview_${sessionId}`, JSON.stringify({ plan, questions, deepMode: interviewMode === 'deep', systemDesign: interviewMode === 'system_design' }));

      router.push(`/interview/session/${sessionId}`);
    } catch (error: unknown) {
      toast({ title: '면접 설정 실패', description: error instanceof Error ? error.message : '알 수 없는 오류', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">면접 시작</h1>
        <p className="text-muted-foreground">
          이력서를 선택하고, 선택적으로 채용 공고를 입력하면 AI가 맞춤 면접을 설계합니다. 음성으로 답변하며 실전 감각을 키우세요.
        </p>
      </div>

      {/* Browser compatibility warning */}
      {!speechSupported && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-medium text-amber-800 dark:text-amber-200">
              이 브라우저는 음성 인식을 지원하지 않습니다
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Chrome 또는 Edge 브라우저를 사용해주세요. 음성 면접을 진행하려면 음성 인식이 필요합니다.
            </p>
          </div>
        </div>
      )}

      {/* In-progress session banner */}
      {inProgressSession && (
        <div className="flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <div className="space-y-1">
            <p className="font-medium text-amber-800 dark:text-amber-200">
              진행 중인 면접이 있습니다
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {inProgressSession.type === 'TECHNICAL' ? '기술' : inProgressSession.type === 'BEHAVIORAL' ? '인성' : '종합'} 면접
              {' · '}
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
                AI 면접 설계
              </CardTitle>
              <CardDescription>
                {jobPostingData
                  ? '채용 공고와 이력서를 기반으로 AI가 면접 유형, 카테고리, 난이도, 질문 수를 자동으로 결정합니다'
                  : '이력서를 기반으로 AI가 면접 유형, 카테고리, 난이도, 질문 수를 자동으로 결정합니다'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {jobPostingData ? (
                  <>
                    <li>- 공고의 요구 기술과 이력서 스킬을 비교하여 카테고리 선택</li>
                    <li>- 경력 수준에 맞는 난이도 자동 조절</li>
                    <li>- 강점 검증 + 약점 보완 질문을 균형 있게 배치</li>
                  </>
                ) : (
                  <>
                    <li>- 이력서의 기술스택과 프로젝트 경험을 분석하여 카테고리 선택</li>
                    <li>- 경력 수준에 맞는 난이도 자동 조절</li>
                    <li>- 프로젝트 심층 + 기술 역량 + 성장 관련 질문을 균형 있게 배치</li>
                  </>
                )}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="h-5 w-5" />
                면접 모드
              </CardTitle>
              <CardDescription>면접 유형을 선택하세요</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                {/* 일반 모드 */}
                <button
                  type="button"
                  className={cn(
                    'rounded-lg border p-4 text-left transition-all',
                    interviewMode === 'standard'
                      ? 'border-primary ring-2 ring-primary/20 bg-primary/5'
                      : 'hover:border-muted-foreground/50'
                  )}
                  onClick={() => setInterviewMode('standard')}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Mic className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold">일반 모드</span>
                  </div>
                  <p className="text-xs text-muted-foreground">5~10 질문, 전반적 커버리지</p>
                </button>

                {/* 심화 모드 */}
                <button
                  type="button"
                  className={cn(
                    'rounded-lg border p-4 text-left transition-all',
                    interviewMode === 'deep'
                      ? 'border-violet-500 ring-2 ring-violet-500/20 bg-violet-50 dark:bg-violet-950/30'
                      : 'hover:border-muted-foreground/50'
                  )}
                  onClick={() => setInterviewMode('deep')}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <FlaskConical className="h-4 w-4 text-violet-500" />
                    <span className="text-sm font-semibold">심화 모드</span>
                  </div>
                  <p className="text-xs text-muted-foreground">3~5 질문, 기술 깊이 집중</p>
                </button>

                {/* 시스템 설계 모드 */}
                <button
                  type="button"
                  className={cn(
                    'rounded-lg border p-4 text-left transition-all',
                    interviewMode === 'system_design'
                      ? 'border-blue-500 ring-2 ring-blue-500/20 bg-blue-50 dark:bg-blue-950/30'
                      : 'hover:border-muted-foreground/50'
                  )}
                  onClick={() => setInterviewMode('system_design')}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Layers className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-semibold">시스템 설계</span>
                  </div>
                  <p className="text-xs text-muted-foreground">2~3 문제, 단계별 설계</p>
                </button>
              </div>

              {interviewMode === 'deep' && (
                <div className="mt-3 rounded-lg bg-violet-50 p-3 dark:bg-violet-950/30">
                  <ul className="space-y-1 text-sm text-violet-700 dark:text-violet-300">
                    <li>- 이력서의 프로젝트/기술을 직접 언급하는 질문</li>
                    <li>- INTERMEDIATE 이상 난이도, 점진적 깊이 증가</li>
                    <li>- 매 질문 후 꼬리질문으로 더 깊이 파고듦</li>
                  </ul>
                </div>
              )}

              {interviewMode === 'system_design' && (
                <div className="mt-3 rounded-lg bg-blue-50 p-3 dark:bg-blue-950/30">
                  <ul className="space-y-1 text-sm text-blue-700 dark:text-blue-300">
                    <li>- 요구사항 확인 → 고수준 설계 → 세부 설계 → 트레이드오프</li>
                    <li>- 이력서 기반 실무 연결 설계 문제</li>
                    <li>- 아키텍처 설계 역량 집중 평가</li>
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <Button
            size="lg"
            className="w-full"
            onClick={startInterview}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                AI가 면접을 설계하고 있습니다...
              </>
            ) : (
              <>
                <Mic className="mr-2 h-4 w-4" />
                면접 시작하기
              </>
            )}
          </Button>
        </>
      )}

      <InsufficientCreditsDialog open={showCreditsDialog} onOpenChange={setShowCreditsDialog} />
    </div>
  );
}
