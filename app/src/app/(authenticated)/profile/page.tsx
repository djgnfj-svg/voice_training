'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/useToast';
import { Upload, FileText, CheckCircle, Loader2, Trash2, Pencil, ChevronDown, ChevronUp } from 'lucide-react';
import type { ParsedResume } from '@/types';

interface ResumeListItem {
  id: string;
  name: string;
  parsedData: ParsedResume | null;
  createdAt: string;
}

export default function ProfilePage() {
  const [isDragging, setIsDragging] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: resumes, isLoading } = useQuery<ResumeListItem[]>({
    queryKey: ['resumes-full'],
    queryFn: async () => {
      const res = await fetch('/api/resume');
      if (!res.ok) throw new Error('Failed to fetch resumes');
      // GET /api/resume returns ResumeItem[] (id, name, skills, createdAt)
      // We need full data for the profile page, so we fetch each one
      const items = await res.json();
      // Fetch full details for each
      const details = await Promise.all(
        items.map(async (item: any) => {
          const detailRes = await fetch(`/api/resume/${item.id}`);
          if (!detailRes.ok) return { ...item, parsedData: null };
          const detail = await detailRes.json();
          return {
            id: detail.id,
            name: detail.name,
            parsedData: detail.parsedData as ParsedResume | null,
            createdAt: detail.createdAt,
          };
        })
      );
      return details;
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
      queryClient.invalidateQueries({ queryKey: ['resumes-full'] });
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      toast({ title: '이력서가 업로드되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '업로드 실패', description: error.message, variant: 'destructive' });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await fetch(`/api/resume/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Rename failed');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes-full'] });
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      setRenamingId(null);
      toast({ title: '이름이 변경되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '이름 변경 실패', description: error.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/resume/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes-full'] });
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      toast({ title: '이력서가 삭제되었습니다' });
    },
    onError: (error: Error) => {
      toast({ title: '삭제 실패', description: error.message, variant: 'destructive' });
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

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const submitRename = (id: string) => {
    if (renameValue.trim()) {
      renameMutation.mutate({ id, name: renameValue.trim() });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">이력서 관리</h1>
        <p className="text-muted-foreground">이력서를 업로드하고 관리하여 음성 면접 맞춤 질문을 받으세요</p>
      </div>

      {/* Upload Area */}
      <Card>
        <CardHeader>
          <CardTitle>새 이력서 업로드</CardTitle>
          <CardDescription>PDF 형식의 이력서를 업로드해주세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 md:p-12 transition-colors ${
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

      {/* Resume List */}
      {isLoading ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : resumes && resumes.length > 0 ? (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">내 이력서 ({resumes.length}개)</h2>
          {resumes.map((resume) => {
            const parsed = resume.parsedData;
            const isExpanded = expandedId === resume.id;

            return (
              <Card key={resume.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-5 w-5 text-green-500" />
                      {renamingId === resume.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') submitRename(resume.id);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            className="h-8 w-32 sm:w-48"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => submitRename(resume.id)}
                            disabled={renameMutation.isPending}
                          >
                            저장
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRenamingId(null)}
                          >
                            취소
                          </Button>
                        </div>
                      ) : (
                        <CardTitle className="text-base">{resume.name}</CardTitle>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="mr-2 text-xs text-muted-foreground">
                        {new Date(resume.createdAt).toLocaleDateString('ko-KR')}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => startRename(resume.id, resume.name)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm('이력서를 삭제하시겠습니까?')) {
                            deleteMutation.mutate(resume.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpandedId(isExpanded ? null : resume.id)}
                      >
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {/* Skill badges (always visible) */}
                  {parsed?.skills && parsed.skills.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {parsed.skills.slice(0, 8).map((skill) => (
                        <Badge key={skill} variant="secondary" className="text-xs">
                          {skill}
                        </Badge>
                      ))}
                      {parsed.skills.length > 8 && (
                        <Badge variant="outline" className="text-xs">
                          +{parsed.skills.length - 8}
                        </Badge>
                      )}
                    </div>
                  )}
                </CardHeader>

                {/* Expanded details */}
                {isExpanded && parsed && (
                  <CardContent className="space-y-6 border-t pt-4">
                    {parsed.name && (
                      <div>
                        <h3 className="mb-1 text-sm font-medium text-muted-foreground">이름</h3>
                        <p className="font-medium">{parsed.name}</p>
                      </div>
                    )}
                    {parsed.skills && parsed.skills.length > 0 && (
                      <div>
                        <h3 className="mb-2 text-sm font-medium text-muted-foreground">기술 스택</h3>
                        <div className="flex flex-wrap gap-2">
                          {parsed.skills.map((skill) => (
                            <Badge key={skill} variant="secondary">{skill}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {parsed.experience && parsed.experience.length > 0 && (
                      <div>
                        <h3 className="mb-2 text-sm font-medium text-muted-foreground">경력</h3>
                        <div className="space-y-3">
                          {parsed.experience.map((exp, i) => (
                            <div key={i} className="rounded-lg border p-3">
                              <p className="font-medium">{exp.company} - {exp.position}</p>
                              <p className="text-sm text-muted-foreground">{exp.period}</p>
                              <p className="mt-1 text-sm">{exp.description}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {parsed.projects && parsed.projects.length > 0 && (
                      <div>
                        <h3 className="mb-2 text-sm font-medium text-muted-foreground">프로젝트</h3>
                        <div className="space-y-3">
                          {parsed.projects.map((proj, i) => (
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
                )}
              </Card>
            );
          })}
        </div>
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
