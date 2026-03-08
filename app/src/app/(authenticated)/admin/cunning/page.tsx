'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { isAdmin } from '@/lib/admin';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { useToast } from '@/hooks/useToast';
import { Eye, ArrowRight, Mic } from 'lucide-react';
import { isSpeechRecognitionSupported } from '@/lib/utils';

export default function CunningSetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { data: session } = useSession();
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null);
  const [jobPostingText, setJobPostingText] = useState('');

  if (!isAdmin(session?.user?.email)) {
    router.push('/dashboard');
    return null;
  }

  const handleStart = () => {
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

    if (jobPostingText.trim()) {
      sessionStorage.setItem('cunning_job_posting', jobPostingText.trim());
    } else {
      sessionStorage.removeItem('cunning_job_posting');
    }

    router.push(`/admin/cunning/${selectedResumeId}`);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">컨닝 모드</h1>
        <p className="text-muted-foreground">
          실제 면접에서 면접관의 질문을 실시간으로 감지하고, 이력서 기반 최적 답변을 제안합니다
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            사용 방법
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>1. 이력서를 선택하세요 (필수)</li>
            <li>2. 채용공고가 있다면 텍스트를 붙여넣으세요 (선택)</li>
            <li>3. 시작 후 마이크로 면접관의 질문을 들으면 자동으로 답변을 생성합니다</li>
            <li>4. 2초간 침묵이 감지되면 질문이 완료된 것으로 판단합니다</li>
            <li>5. 답변 중에는 일시정지로 인식을 멈출 수 있습니다</li>
          </ul>
        </CardContent>
      </Card>

      <ResumeSelector selectedId={selectedResumeId} onSelect={setSelectedResumeId} />

      <Card>
        <CardHeader>
          <CardTitle>채용공고 (선택)</CardTitle>
          <CardDescription>
            채용공고 텍스트를 입력하면 해당 포지션에 맞춘 답변을 생성합니다
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
        <Mic className="mr-2 h-4 w-4" />
        컨닝 모드 시작
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}
