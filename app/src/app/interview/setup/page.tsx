'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { JobPostingInput, JobPostingResult } from '@/components/job-posting/job-posting-input';
import { useToast } from '@/hooks/useToast';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Loader2, Mic, Sparkles, ArrowRight, SkipForward, FlaskConical } from 'lucide-react';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';

type Step = 'resume' | 'job-posting' | 'start';

export default function InterviewSetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('resume');

  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [deepMode, setDeepMode] = useState(false);
  const [jobPostingData, setJobPostingData] = useState<{
    id: string;
    parsedData: ParsedJobPosting;
    companyAnalysis: CompanyAnalysis;
  } | null>(null);

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
  }) => {
    setJobPostingData(data);
    setStep('start');
  };

  const startInterview = async () => {
    if (!selectedResumeId) {
      toast({ title: '이력서를 선택해주세요', variant: 'destructive' });
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
          deepMode,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Setup failed');
      }

      const data = await res.json();
      const { sessionId, plan, questions } = data;

      sessionStorage.setItem(`interview_${sessionId}`, JSON.stringify({ plan, questions, deepMode }));

      router.push(`/interview/session/${sessionId}`);
    } catch (error: any) {
      toast({ title: '면접 설정 실패', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">면접 시작</h1>
        <p className="text-muted-foreground">
          이력서를 선택하고, 선택적으로 채용 공고를 입력하면 AI가 맞춤 면접을 설계합니다
        </p>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-2 text-sm">
        <span className={step === 'resume' ? 'font-bold text-primary' : 'text-muted-foreground'}>
          1. 이력서 선택
        </span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className={step === 'job-posting' ? 'font-bold text-primary' : 'text-muted-foreground'}>
          2. 채용공고 (선택)
        </span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className={step === 'start' ? 'font-bold text-primary' : 'text-muted-foreground'}>
          3. 면접 시작
        </span>
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
              parsedData={jobPostingData.parsedData}
              companyAnalysis={jobPostingData.companyAnalysis}
            />
          )}
        </>
      )}

      {/* Step 3: Start Interview */}
      {step === 'start' && (
        <>
          {jobPostingData && (
            <JobPostingResult
              parsedData={jobPostingData.parsedData}
              companyAnalysis={jobPostingData.companyAnalysis}
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

          <Card className={deepMode ? 'border-violet-300 dark:border-violet-800' : ''}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="h-5 w-5" />
                면접 모드
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="deep-mode" className="text-sm font-medium">심화 면접</Label>
                  <p className="text-sm text-muted-foreground">
                    3~5개의 질문으로 기술적 깊이를 집중 검증합니다
                  </p>
                </div>
                <Switch
                  id="deep-mode"
                  checked={deepMode}
                  onCheckedChange={setDeepMode}
                />
              </div>
              {deepMode && (
                <div className="mt-3 rounded-lg bg-violet-50 p-3 dark:bg-violet-950/30">
                  <ul className="space-y-1 text-sm text-violet-700 dark:text-violet-300">
                    <li>- 이력서의 프로젝트/기술을 직접 언급하는 질문</li>
                    <li>- INTERMEDIATE 이상 난이도, 점진적 깊이 증가</li>
                    <li>- 매 질문 후 꼬리질문으로 더 깊이 파고듦</li>
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
    </div>
  );
}
