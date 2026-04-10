'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  ArrowLeft,
  Eye,
  EyeOff,
  BookOpen,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  AlertCircle,
} from 'lucide-react';

import { formatDate } from '@/lib/utils';

interface ActivityItem {
  id: string;
  index: number;
  question: string;
  answer: string;
  extra: {
    modelAnswer?: string;
    keyPoints?: string[];
    answerTips?: string[];
    category?: string;
    difficulty?: string;
  } | null;
}

interface ActivityLog {
  id: string;
  type: 'MODEL_ANSWER';
  resumeId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  resume: { name: string } | null;
  items: ActivityItem[];
}

export default function ActivityReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const { data: log, isLoading, error } = useQuery<ActivityLog>({
    queryKey: ['activity', id],
    queryFn: async () => {
      const res = await fetch(`/api/activity/${id}`);
      if (!res.ok) throw new Error('Failed to load activity');
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !log) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-8 text-center">
            <AlertCircle className="mx-auto h-10 w-10 text-destructive" />
            <p className="mt-4 text-destructive">기록을 불러올 수 없습니다</p>
            <Button className="mt-4" onClick={() => router.push('/history')}>
              히스토리로 돌아가기
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <BookOpen className="h-6 w-6" />
            모범답안 복습
          </h1>
          <p className="text-sm text-muted-foreground">
            {log.resume?.name && <span>{log.resume.name} | </span>}
            {formatDate(log.createdAt)} | {log.items.length}개 질문
          </p>
        </div>
        <Button variant="outline" onClick={() => router.push('/history')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          히스토리
        </Button>
      </div>

      <ModelAnswerReview items={log.items} />
    </div>
  );
}

function ModelAnswerReview({ items }: { items: ActivityItem[] }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [revealedAnswers, setRevealedAnswers] = useState<Set<number>>(new Set());

  const item = items[currentIndex];
  const isRevealed = revealedAnswers.has(currentIndex);

  const toggleReveal = (index: number) => {
    setRevealedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const revealAll = () => {
    setRevealedAnswers(new Set(items.map((_, i) => i)));
  };

  if (!item) return null;

  return (
    <div className="space-y-6">
      {/* Question Navigation */}
      <div className="flex flex-wrap items-center gap-2">
        {items.map((_, i) => (
          <Button
            key={i}
            size="sm"
            variant={i === currentIndex ? 'default' : revealedAnswers.has(i) ? 'secondary' : 'outline'}
            className="h-8 w-8 p-0"
            onClick={() => setCurrentIndex(i)}
          >
            {i + 1}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={revealAll}>
          <ChevronsRight className="mr-1 h-4 w-4" />
          전체 공개
        </Button>
      </div>

      {/* Question Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <BookOpen className="h-5 w-5 text-primary" />
            질문 {currentIndex + 1}
            {item.extra?.category && (
              <Badge variant="outline" className="ml-2 text-xs font-normal">
                {item.extra.category}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg leading-relaxed">{item.question}</p>
        </CardContent>
      </Card>

      {/* Reveal / Answer */}
      {!isRevealed ? (
        <Button className="w-full" size="lg" onClick={() => toggleReveal(currentIndex)}>
          <Eye className="mr-2 h-4 w-4" />
          모범답안 보기
        </Button>
      ) : (
        <div className="space-y-4">
          <Card className="border-green-500/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-green-700 dark:text-green-400">
                <CheckCircle className="h-4 w-4" />
                모범답안
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="leading-relaxed whitespace-pre-wrap">
                {item.answer}
              </p>
            </CardContent>
          </Card>

          {item.extra?.keyPoints && item.extra.keyPoints.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <span className="text-sm font-medium">핵심 포인트:</span>
              {item.extra.keyPoints.map((point, i) => (
                <Badge key={i} variant="secondary">
                  {point}
                </Badge>
              ))}
            </div>
          )}

          {item.extra?.answerTips && item.extra.answerTips.length > 0 && (
            <Card className="bg-green-50 dark:bg-green-950/20">
              <CardHeader>
                <CardTitle className="text-sm text-green-700 dark:text-green-400">
                  이 답변이 좋은 이유
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1">
                  {item.extra.answerTips.map((tip, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <CheckCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-green-600" />
                      {tip}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Button
            variant="outline"
            className="w-full"
            onClick={() => toggleReveal(currentIndex)}
          >
            <EyeOff className="mr-2 h-4 w-4" />
            답안 숨기기
          </Button>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between pt-2">
        <Button
          variant="outline"
          onClick={() => setCurrentIndex(currentIndex - 1)}
          disabled={currentIndex === 0}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          이전 질문
        </Button>
        <span className="text-sm text-muted-foreground">
          {currentIndex + 1} / {items.length}
        </span>
        <Button
          variant="outline"
          onClick={() => setCurrentIndex(currentIndex + 1)}
          disabled={currentIndex === items.length - 1}
        >
          다음 질문
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
