'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { InsufficientCreditsDialog } from '@/components/credit/insufficient-credits-dialog';
import { useToast } from '@/hooks/useToast';
import { Loader2, CheckCircle, Building2, Search, Coins, Newspaper, Package, MessageSquare, Target, HelpCircle } from 'lucide-react';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';

interface JobPostingInputProps {
  onAnalyzed: (data: { id: string; parsedData: ParsedJobPosting; companyAnalysis: CompanyAnalysis; deepResearchAvailable: boolean }) => void;
}

export function JobPostingInput({ onAnalyzed }: JobPostingInputProps) {
  const [rawText, setRawText] = useState('');
  const { toast } = useToast();

  const analyzeMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch('/api/job-posting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: text }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Analysis failed');
      }
      return res.json();
    },
    onSuccess: (data) => {
      onAnalyzed({
        id: data.id,
        parsedData: data.parsedData,
        companyAnalysis: data.companyAnalysis,
        deepResearchAvailable: data.deepResearchAvailable ?? false,
      });
      toast({ title: '채용 공고가 분석되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '분석 실패', description: error.message, variant: 'destructive' });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          채용 공고 입력
        </CardTitle>
        <CardDescription>
          채용 공고 텍스트를 붙여넣으면 해당 포지션에 맞춘 면접 질문을 생성합니다
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Textarea
          placeholder="채용 공고 텍스트를 여기에 붙여넣으세요...&#10;&#10;예시:&#10;[회사명] 백엔드 개발자 채용&#10;- 자격요건: Java, Spring Boot 경험 3년 이상&#10;- 우대사항: MSA, Docker 경험&#10;..."
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={8}
          className="resize-none"
        />
        <Button
          onClick={() => analyzeMutation.mutate(rawText)}
          disabled={rawText.length < 10 || analyzeMutation.isPending}
          className="w-full"
        >
          {analyzeMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              분석 중...
            </>
          ) : (
            '공고 분석하기'
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

interface JobPostingResultProps {
  jobPostingId: string;
  parsedData: ParsedJobPosting;
  companyAnalysis: CompanyAnalysis;
  deepResearchAvailable?: boolean;
  onCompanyAnalysisUpdate?: (analysis: CompanyAnalysis) => void;
}

export function JobPostingResult({
  jobPostingId,
  parsedData,
  companyAnalysis,
  deepResearchAvailable,
  onCompanyAnalysisUpdate,
}: JobPostingResultProps) {
  const { toast } = useToast();
  const [showCreditsDialog, setShowCreditsDialog] = useState(false);

  const deepResearchMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/job-posting/${jobPostingId}/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const data = await res.json();
        if (res.status === 402) {
          throw Object.assign(new Error(data.error), { code: 'INSUFFICIENT_CREDITS' });
        }
        throw new Error(data.error || '심층 분석 실패');
      }
      return res.json();
    },
    onSuccess: (data) => {
      onCompanyAnalysisUpdate?.(data.companyAnalysis);
      toast({ title: '심층 기업 분석이 완료되었습니다' });
    },
    onError: (error: Error & { code?: string }) => {
      if (error.code === 'INSUFFICIENT_CREDITS') {
        setShowCreditsDialog(true);
      } else {
        toast({ title: '심층 분석 실패', description: error.message, variant: 'destructive' });
      }
    },
  });

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-500" />
            <CardTitle>분석 결과</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-1 text-sm font-medium text-muted-foreground">회사명</h4>
              <p className="font-medium">{parsedData.company || '-'}</p>
            </div>
            <div>
              <h4 className="mb-1 text-sm font-medium text-muted-foreground">포지션</h4>
              <p className="font-medium">{parsedData.position || '-'}</p>
            </div>
          </div>

          {parsedData.techStack.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">요구 기술스택</h4>
              <div className="flex flex-wrap gap-2">
                {parsedData.techStack.map((tech) => (
                  <Badge key={tech}>{tech}</Badge>
                ))}
              </div>
            </div>
          )}

          {parsedData.requirements.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">필수 자격요건</h4>
              <ul className="list-inside list-disc space-y-1 text-sm">
                {parsedData.requirements.map((req, i) => (
                  <li key={i}>{req}</li>
                ))}
              </ul>
            </div>
          )}

          {parsedData.preferred.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">우대사항</h4>
              <ul className="list-inside list-disc space-y-1 text-sm">
                {parsedData.preferred.map((pref, i) => (
                  <li key={i}>{pref}</li>
                ))}
              </ul>
            </div>
          )}

          {companyAnalysis && (
            <div className="rounded-lg bg-muted/50 p-4">
              <h4 className="mb-2 text-sm font-medium">면접 스타일 분석</h4>
              <p className="text-sm">{companyAnalysis.interviewStyle}</p>
              {companyAnalysis.pastQuestionTrends.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground">자주 나오는 주제:</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {companyAnalysis.pastQuestionTrends.map((trend, i) => (
                      <Badge key={i} variant="outline" className="text-xs">{trend}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 심층 분석 버튼 또는 결과 */}
          {companyAnalysis?.deepResearch ? (
            <DeepResearchResults companyAnalysis={companyAnalysis} />
          ) : deepResearchAvailable ? (
            <div className="rounded-lg border border-dashed border-blue-300 bg-blue-50/50 p-4 dark:border-blue-800 dark:bg-blue-950/20">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h4 className="flex items-center gap-2 text-sm font-medium">
                    <Search className="h-4 w-4 text-blue-500" />
                    심층 기업 분석
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    실제 웹 검색으로 면접 후기, 최근 뉴스, 기출 문제 등을 수집합니다
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => deepResearchMutation.mutate()}
                  disabled={deepResearchMutation.isPending}
                  className="shrink-0"
                >
                  {deepResearchMutation.isPending ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      분석 중...
                    </>
                  ) : (
                    <>
                      <Coins className="mr-1.5 h-3.5 w-3.5" />
                      1크레딧
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <InsufficientCreditsDialog open={showCreditsDialog} onOpenChange={setShowCreditsDialog} />
    </>
  );
}

function DeepResearchResults({ companyAnalysis }: { companyAnalysis: CompanyAnalysis }) {
  return (
    <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/30 p-4 dark:border-blue-900 dark:bg-blue-950/20">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-300">
        <Search className="h-4 w-4" />
        심층 기업 분석 결과
      </h4>

      {companyAnalysis.companyOverview && (
        <div>
          <h5 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            회사 소개
          </h5>
          <p className="text-sm">{companyAnalysis.companyOverview}</p>
        </div>
      )}

      {companyAnalysis.products && companyAnalysis.products.length > 0 && (
        <div>
          <h5 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Package className="h-3.5 w-3.5" />
            핵심 제품/서비스
          </h5>
          <div className="flex flex-wrap gap-1.5">
            {companyAnalysis.products.map((product, i) => (
              <Badge key={i} variant="secondary" className="text-xs">{product}</Badge>
            ))}
          </div>
        </div>
      )}

      {companyAnalysis.recentNews && companyAnalysis.recentNews.length > 0 && (
        <div>
          <h5 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Newspaper className="h-3.5 w-3.5" />
            최근 뉴스
          </h5>
          <ul className="space-y-1 text-sm">
            {companyAnalysis.recentNews.map((news, i) => (
              <li key={i} className="text-xs">- {news}</li>
            ))}
          </ul>
        </div>
      )}

      {companyAnalysis.interviewReviews && companyAnalysis.interviewReviews.length > 0 && (
        <div>
          <h5 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            면접 후기
          </h5>
          <ul className="space-y-1 text-sm">
            {companyAnalysis.interviewReviews.map((review, i) => (
              <li key={i} className="text-xs">- {review}</li>
            ))}
          </ul>
        </div>
      )}

      {companyAnalysis.keyTopicsForInterview && companyAnalysis.keyTopicsForInterview.length > 0 && (
        <div>
          <h5 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Target className="h-3.5 w-3.5" />
            면접 필수 토픽
          </h5>
          <div className="flex flex-wrap gap-1.5">
            {companyAnalysis.keyTopicsForInterview.map((topic, i) => (
              <Badge key={i} className="text-xs">{topic}</Badge>
            ))}
          </div>
        </div>
      )}

      {companyAnalysis.suggestedQuestions && companyAnalysis.suggestedQuestions.length > 0 && (
        <div>
          <h5 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <HelpCircle className="h-3.5 w-3.5" />
            예상 질문
          </h5>
          <ul className="space-y-1.5">
            {companyAnalysis.suggestedQuestions.map((q, i) => (
              <li key={i} className="rounded-md bg-white/60 px-3 py-1.5 text-xs dark:bg-white/5">
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
