'use client';

import { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Flame, Sparkles, TrendingUp } from 'lucide-react';
import type { EndResponse } from '@/lib/nightly-study-api';

interface Props {
  result: EndResponse;
  onClose: () => void;
}

export function BriefingView({ result, onClose }: Props) {
  const learned = result.highlights?.learned ?? [];
  const improved = result.highlights?.improved ?? [];
  const headline = result.highlights?.headline ?? '오늘도 수고하셨어요';
  const streak = result.streakUpdated ?? { current: 0, longest: 0, totalSessions: 0, totalNodesLearned: 0, isNewRecord: false };

  useEffect(() => {
    const text = result.voiceBriefing;
    if (!text) return;
    (async () => {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, persona: 'tutor' }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        await audio.play();
        audio.onended = () => URL.revokeObjectURL(url);
      } catch {}
    })();
  }, [result.voiceBriefing]);

  return (
    <div className="space-y-4 p-4 pb-8">
      <h2 className="text-xl font-bold text-center">수고하셨어요</h2>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> 오늘의 하이라이트
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-base">{headline}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" /> 새로 이해한 것
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {learned.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="text-sm space-y-1">
              {learned.map((item, i) => (
                <li key={i}>• {item}</li>
              ))}
            </ul>
          )}
          {improved.length > 0 && (
            <div className="pt-2 border-t mt-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">개선 포인트</p>
              <ul className="text-sm space-y-1">
                {improved.map((item, i) => (
                  <li key={i}>• {item}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-2">
            <Flame className="h-6 w-6 text-orange-500" />
            <span className="text-lg font-bold">{streak.current}일</span>
            {streak.isNewRecord && (
              <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">최고 기록</span>
            )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>총 {streak.totalSessions}회 학습</div>
            <div>{streak.totalNodesLearned}개 토픽 마스터</div>
          </div>
        </CardContent>
      </Card>

      <Button onClick={onClose} className="w-full">확인</Button>
    </div>
  );
}
