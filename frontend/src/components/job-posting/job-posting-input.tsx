'use client';

import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { Loader2, CheckCircle, Building2, Paperclip, ImagePlus } from 'lucide-react';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';

interface JobPostingInputProps {
  onAnalyzed: (data: { id: string; rawText: string; parsedData: ParsedJobPosting; companyAnalysis: CompanyAnalysis }) => void;
}

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

export function JobPostingInput({ onAnalyzed }: JobPostingInputProps) {
  const [rawText, setRawText] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  async function handleImageFile(file: File) {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      toast({
        title: '지원하지 않는 이미지 형식',
        description: 'PNG, JPEG, WebP만 지원합니다',
        variant: 'destructive',
      });
      return;
    }
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      toast({
        title: '이미지가 너무 큽니다',
        description: '5MB 이하의 이미지만 업로드할 수 있습니다',
        variant: 'destructive',
      });
      return;
    }

    setIsExtracting(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetch('/api/job-posting/extract-image', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || '텍스트 추출 실패');
      }
      const { text } = (await res.json()) as { text: string };

      if (!text || text.trim().length === 0) {
        toast({
          title: '텍스트를 읽을 수 없습니다',
          description: '다른 이미지를 시도하거나 직접 입력해 주세요',
          variant: 'destructive',
        });
        return;
      }

      setRawText((prev) => (prev.trim().length === 0 ? text : `${prev}\n\n${text}`));
      toast({ title: '텍스트를 추출했습니다' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '텍스트 추출 실패';
      toast({ title: '추출 실패', description: msg, variant: 'destructive' });
    } finally {
      setIsExtracting(false);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    if (isExtracting) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void handleImageFile(file);
          return;
        }
      }
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (isExtracting) return;
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      void handleImageFile(file);
    }
  }

  return (
    <Card
      onPaste={handlePaste}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className={isDragOver ? 'ring-2 ring-primary' : undefined}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          채용 공고 입력
        </CardTitle>
        <CardDescription>
          텍스트를 붙여넣거나, 스크린샷 이미지를 업로드/붙여넣기(Ctrl+V)/드래그할 수 있습니다
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isExtracting || analyzeMutation.isPending}
          >
            <Paperclip className="mr-2 h-4 w-4" />
            이미지 파일 선택
          </Button>
          <span className="text-xs text-muted-foreground">
            <ImagePlus className="mr-1 inline h-3.5 w-3.5" />
            Ctrl+V로 스크린샷 붙여넣기 · 드래그 앤 드롭도 가능
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImageFile(file);
              e.target.value = '';
            }}
          />
        </div>

        {isExtracting && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            이미지에서 텍스트 추출 중...
          </div>
        )}

        <Textarea
          placeholder="채용 공고 텍스트를 여기에 붙여넣으세요...&#10;&#10;예시:&#10;[회사명] 백엔드 개발자 채용&#10;- 자격요건: Java, Spring Boot 경험 3년 이상&#10;- 우대사항: MSA, Docker 경험&#10;..."
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={8}
          className="resize-none"
          disabled={isExtracting}
        />
        <Button
          onClick={() => analyzeMutation.mutate(rawText)}
          disabled={rawText.length < 10 || analyzeMutation.isPending || isExtracting}
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
