'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { Loader2, CheckCircle, Building2 } from 'lucide-react';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';

interface JobPostingInputProps {
  onAnalyzed: (data: { id: string; rawText: string; parsedData: ParsedJobPosting; companyAnalysis: CompanyAnalysis }) => void;
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
    onSuccess: (data, variables) => {
      onAnalyzed({
        id: data.id,
        rawText: variables,
        parsedData: data.parsedData,
        companyAnalysis: data.companyAnalysis,
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
  parsedData: ParsedJobPosting;
  companyAnalysis: CompanyAnalysis;
}

export function JobPostingResult({
  parsedData,
  companyAnalysis,
}: JobPostingResultProps) {
  return (
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
            {companyAnalysis.pastQuestionTrends?.length > 0 && (
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
      </CardContent>
    </Card>
  );
}
