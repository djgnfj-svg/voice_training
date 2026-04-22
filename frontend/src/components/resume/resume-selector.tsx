'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { Upload, FileText, CheckCircle, Loader2 } from 'lucide-react';
import type { ResumeItem } from '@/types';

interface ResumeSelectorProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ResumeSelector({ selectedId, onSelect }: ResumeSelectorProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isDragging, setIsDragging] = useState(false);

  const { data: resumes, isLoading } = useQuery<ResumeItem[]>({
    queryKey: ['resumes', { detail: false }],
    queryFn: async () => {
      const res = await fetch('/api/resume');
      if (!res.ok) throw new Error('Failed to fetch resumes');
      return res.json();
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
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['resumes'] }); // 모든 detail 변종 invalidate
      onSelect(data.id);
      toast({ title: '이력서가 업로드되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '업로드 실패', description: error.message, variant: 'destructive' });
    },
  });

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.pdf')) {
      toast({ title: 'PDF 파일만 업로드 가능합니다', variant: 'destructive' });
      return;
    }
    uploadMutation.mutate(file);
  }, [uploadMutation, toast]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          이력서 선택
        </CardTitle>
        <CardDescription>면접에 사용할 이력서를 선택하세요</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {resumes && resumes.length > 0 ? (
          <div className="grid gap-3">
            {resumes.map((resume) => (
              <div
                key={resume.id}
                className={`cursor-pointer rounded-lg border-2 p-4 transition-colors ${
                  selectedId === resume.id
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent bg-muted/50 hover:border-muted-foreground/25'
                }`}
                onClick={() => onSelect(resume.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {selectedId === resume.id && (
                      <CheckCircle className="h-4 w-4 text-primary" />
                    )}
                    <span className="font-medium">{resume.name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(resume.createdAt).toLocaleDateString('ko-KR')}
                  </span>
                </div>
                {resume.skills.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {resume.skills.slice(0, 5).map((skill) => (
                      <Badge key={skill} variant="secondary" className="text-xs">
                        {skill}
                      </Badge>
                    ))}
                    {resume.skills.length > 5 && (
                      <Badge variant="outline" className="text-xs">
                        +{resume.skills.length - 5}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : null}

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
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={!uploadMutation.isPending ? handleFileSelect : undefined}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors ${
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-primary/50'
          } ${uploadMutation.isPending ? 'pointer-events-none opacity-60' : ''}`}
        >
          {uploadMutation.isPending ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm font-medium">이력서 분석 중...</p>
            </>
          ) : (
            <>
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">
                PDF 파일을 드래그하거나 클릭하여 업로드
              </p>
              <p className="text-xs text-muted-foreground">PDF만 지원</p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
