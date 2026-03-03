'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { useToast } from '@/hooks/useToast';
import { BookOpen, ArrowRight, Lightbulb } from 'lucide-react';

export default function ModelAnswerSetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [jobPostingText, setJobPostingText] = useState('');

  const handleStart = () => {
    if (!selectedResumeId) {
      toast({ title: '이력서를 선택해주세요', variant: 'destructive' });
      return;
    }

    if (jobPostingText.trim()) {
      sessionStorage.setItem('model_answer_job_posting', jobPostingText.trim());
    } else {
      sessionStorage.removeItem('model_answer_job_posting');
    }

    router.push(`/interview/model-answer/${selectedResumeId}`);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">모범답안 학습</h1>
        <p className="text-muted-foreground">
          이력서 기반으로 예상 질문과 모범답안을 생성하여, 면접 전에 미리 학습할 수 있습니다
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lightbulb className="h-5 w-5" />
            사용 방법
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>1. 이력서를 선택하세요 (필수)</li>
            <li>2. 채용공고가 있다면 텍스트를 붙여넣으세요 (선택)</li>
            <li>3. AI가 예상 질문과 모범답안을 생성합니다</li>
            <li>4. 질문을 보고 먼저 자신만의 답변을 생각해보세요</li>
            <li>5. 모범답안을 공개하여 비교하고 학습하세요</li>
          </ul>
        </CardContent>
      </Card>

      <ResumeSelector selectedId={selectedResumeId} onSelect={setSelectedResumeId} />

      <Card>
        <CardHeader>
          <CardTitle>채용공고 (선택)</CardTitle>
          <CardDescription>
            채용공고 텍스트를 입력하면 해당 포지션에 맞춘 질문과 모범답안을 생성합니다
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            placeholder="채용공고 내용을 붙여넣으세요..."
            value={jobPostingText}
            onChange={(e) => setJobPostingText(e.target.value)}
            rows={6}
          />
        </CardContent>
      </Card>

      <Button
        size="lg"
        className="w-full"
        onClick={handleStart}
        disabled={!selectedResumeId}
      >
        <BookOpen className="mr-2 h-4 w-4" />
        모범답안 학습 시작
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}
