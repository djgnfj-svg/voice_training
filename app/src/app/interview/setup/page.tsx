'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { JobPostingInput, JobPostingResult } from '@/components/job-posting/job-posting-input';
import { useToast } from '@/hooks/useToast';
import { Loader2, Settings, Mic } from 'lucide-react';
import type { ParsedJobPosting, CompanyAnalysis, InterviewType, Difficulty } from '@/types';
import { TECHNICAL_CATEGORIES } from '@/types';

const difficultyLabels: Record<Difficulty, string> = {
  BEGINNER: '초급',
  INTERMEDIATE: '중급',
  ADVANCED: '고급',
};

const typeLabels: Record<InterviewType, string> = {
  TECHNICAL: '기술면접',
  BEHAVIORAL: '인성면접',
  MIXED: '혼합면접',
};

const allCategories = Object.entries(TECHNICAL_CATEGORIES).flatMap(([key, cat]) =>
  cat.subcategories.map((sub) => ({ id: `${key}_${sub}`, label: sub, parent: cat.label }))
);

export default function InterviewSetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  // Job posting state
  const [jobPostingData, setJobPostingData] = useState<{
    id: string;
    parsedData: ParsedJobPosting;
    companyAnalysis: CompanyAnalysis;
  } | null>(null);

  // Interview settings
  const [type, setType] = useState<InterviewType>('TECHNICAL');
  const [difficulty, setDifficulty] = useState<Difficulty>('INTERMEDIATE');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(5);

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories((prev) =>
      prev.includes(categoryId)
        ? prev.filter((c) => c !== categoryId)
        : [...prev, categoryId]
    );
  };

  const startInterview = async () => {
    if (selectedCategories.length === 0) {
      toast({ title: '카테고리를 선택해주세요', variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/interview/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobPostingId: jobPostingData?.id,
          type,
          categories: selectedCategories,
          difficulty,
          totalQuestions,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Setup failed');
      }

      const data = await res.json();
      const { sessionId, questions } = data;

      // Store questions in sessionStorage for the session page
      sessionStorage.setItem(`interview_${sessionId}`, JSON.stringify({ questions }));

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
        <h1 className="text-3xl font-bold">면접 설정</h1>
        <p className="text-muted-foreground">면접 유형과 카테고리를 선택하세요</p>
      </div>

      {/* Step 1: Job Posting (Optional) */}
      {!jobPostingData ? (
        <JobPostingInput onAnalyzed={setJobPostingData} />
      ) : (
        <JobPostingResult
          parsedData={jobPostingData.parsedData}
          companyAnalysis={jobPostingData.companyAnalysis}
        />
      )}

      {/* Step 2: Interview Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            면접 설정
          </CardTitle>
          <CardDescription>면접 유형, 카테고리, 난이도를 선택하세요</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Type */}
          <div className="space-y-2">
            <Label>면접 유형</Label>
            <Select value={type} onValueChange={(v) => setType(v as InterviewType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(typeLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Difficulty */}
          <div className="space-y-2">
            <Label>난이도</Label>
            <Select value={difficulty} onValueChange={(v) => setDifficulty(v as Difficulty)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(difficultyLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Question Count */}
          <div className="space-y-2">
            <Label>질문 수</Label>
            <Select value={totalQuestions.toString()} onValueChange={(v) => setTotalQuestions(parseInt(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[3, 5, 7, 10, 15].map((n) => (
                  <SelectItem key={n} value={n.toString()}>{n}문제</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Categories */}
          <div className="space-y-2">
            <Label>카테고리 (복수 선택 가능)</Label>
            <div className="space-y-4">
              {Object.entries(TECHNICAL_CATEGORIES).map(([key, cat]) => (
                <div key={key}>
                  <p className="mb-2 text-sm font-medium text-muted-foreground">{cat.label}</p>
                  <div className="flex flex-wrap gap-2">
                    {cat.subcategories.map((sub) => {
                      const id = `${key}_${sub}`;
                      const isSelected = selectedCategories.includes(id);
                      return (
                        <Badge
                          key={id}
                          variant={isSelected ? 'default' : 'outline'}
                          className="cursor-pointer"
                          onClick={() => toggleCategory(id)}
                        >
                          {sub}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Start Button */}
      <Button
        size="lg"
        className="w-full"
        onClick={startInterview}
        disabled={loading || selectedCategories.length === 0}
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            면접 준비 중...
          </>
        ) : (
          <>
            <Mic className="mr-2 h-4 w-4" />
            면접 시작하기
          </>
        )}
      </Button>
    </div>
  );
}
