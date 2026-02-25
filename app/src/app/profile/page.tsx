'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { Upload, FileText, CheckCircle, Loader2 } from 'lucide-react';
import type { ParsedResume } from '@/types';

export default function ProfilePage() {
  const [isDragging, setIsDragging] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: resume, isLoading } = useQuery<ParsedResume>({
    queryKey: ['resume'],
    queryFn: async () => {
      const res = await fetch('/api/resume');
      if (!res.ok) throw new Error('Failed to fetch resume');
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resume'] });
      toast({ title: '이력서가 업로드되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '업로드 실패', description: error.message, variant: 'destructive' });
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

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">이력서 관리</h1>
        <p className="text-muted-foreground">이력서를 업로드하면 맞춤 면접 질문을 생성할 수 있습니다</p>
      </div>

      {/* Upload Area */}
      <Card>
        <CardHeader>
          <CardTitle>이력서 업로드</CardTitle>
          <CardDescription>PDF 형식의 이력서를 업로드해주세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-12 transition-colors ${
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
                  type="file"
                  accept=".pdf"
                  onChange={handleInputChange}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  style={{ position: 'relative' }}
                />
                <Button variant="outline" className="mt-4" onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.pdf';
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) handleFile(file);
                  };
                  input.click();
                }}>
                  파일 선택
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Parsed Resume */}
      {isLoading ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : resume ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <CardTitle>분석된 이력서</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {resume.name && (
              <div>
                <h3 className="mb-1 text-sm font-medium text-muted-foreground">이름</h3>
                <p className="font-medium">{resume.name}</p>
              </div>
            )}
            {resume.skills && resume.skills.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">기술 스택</h3>
                <div className="flex flex-wrap gap-2">
                  {resume.skills.map((skill) => (
                    <Badge key={skill} variant="secondary">{skill}</Badge>
                  ))}
                </div>
              </div>
            )}
            {resume.experience && resume.experience.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">경력</h3>
                <div className="space-y-3">
                  {resume.experience.map((exp, i) => (
                    <div key={i} className="rounded-lg border p-3">
                      <p className="font-medium">{exp.company} - {exp.position}</p>
                      <p className="text-sm text-muted-foreground">{exp.period}</p>
                      <p className="mt-1 text-sm">{exp.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {resume.projects && resume.projects.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">프로젝트</h3>
                <div className="space-y-3">
                  {resume.projects.map((proj, i) => (
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
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <FileText className="mx-auto mb-4 h-10 w-10" />
            <p>아직 이력서가 등록되지 않았습니다</p>
            <p className="text-sm">위에서 PDF 이력서를 업로드해주세요</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
