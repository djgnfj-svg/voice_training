'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TopicSelector } from '@/components/nightly-study/topic-selector';
import { ResumeSelector } from '@/components/resume/resume-selector';
import { MicCheckDialog } from '@/components/interview/mic-check-dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Moon, Clock } from 'lucide-react';

export default function NightlyStudyPage() {
  const router = useRouter();
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedMode, setSelectedMode] = useState<'deep' | 'light'>('deep');
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [showMicCheck, setShowMicCheck] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [dailyLimitReached, setDailyLimitReached] = useState(false);

  // Check daily limit on mount
  useEffect(() => {
    async function checkLimit() {
      try {
        const res = await fetch('/api/nightly-study/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ categories: ['CS_BASICS'], mode: 'deep' }),
        });
        if (!res.ok) {
          const data = await res.json();
          if (data.code === 'DAILY_LIMIT_REACHED') {
            setDailyLimitReached(true);
          }
        }
      } catch {
        // ignore
      }
    }
    if (process.env.NODE_ENV !== 'development') {
      checkLimit();
    }
  }, []);

  const handleTopicSelect = (categories: string[], mode: 'deep' | 'light') => {
    setSelectedCategories(categories);
    setSelectedMode(mode);
    setShowMicCheck(true);
  };

  const handleMicConfirm = () => {
    setShowMicCheck(false);
    // Store selection in sessionStorage and navigate to session page
    sessionStorage.setItem('nightly_study_config', JSON.stringify({
      categories: selectedCategories,
      mode: selectedMode,
      ...(resumeId ? { resumeId } : {}),
    }));
    router.push('/nightly-study/session');
  };

  if (dailyLimitReached) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <div className="text-center">
          <Moon className="mx-auto h-12 w-12 text-primary/50" />
          <h1 className="mt-4 text-2xl font-bold">오늘의 학습</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <Clock className="h-10 w-10 text-muted-foreground" />
            <div className="text-center">
              <p className="text-lg font-semibold">오늘은 이미 학습했어요!</p>
              <p className="mt-1 text-sm text-muted-foreground">
                내일 다시 만나요. 매일 꾸준히 하는 게 가장 중요해요.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="text-center">
        <Moon className="mx-auto h-12 w-12 text-primary" />
        <h1 className="mt-4 text-2xl font-bold">오늘의 학습</h1>
        <p className="mt-2 text-muted-foreground">
          자기 전 5~10분, 가볍게 기술 개념을 복습해보세요
        </p>
      </div>

      <TopicSelector onStart={handleTopicSelect} disabled={isLoading} />

      {/* Optional resume selector */}
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">이력서 선택 (선택사항 — 이력서 기반 질문 가중치)</p>
        <ResumeSelector selectedId={resumeId} onSelect={setResumeId} />
      </div>

      <MicCheckDialog
        open={showMicCheck}
        onOpenChange={setShowMicCheck}
        onConfirm={handleMicConfirm}
        loading={isLoading}
      />
    </div>
  );
}
