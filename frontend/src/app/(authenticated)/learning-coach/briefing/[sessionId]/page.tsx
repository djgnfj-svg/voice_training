'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { getSessionDetail, type EndResponse } from '@/lib/learning-coach-api';
import { BriefingView } from '@/components/learning-coach/briefing-view';

const END_CACHE_KEY = (id: string) => `ns:end:${id}`;

export default function BriefingPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [result, setResult] = useState<EndResponse | null>(null);
  const [cacheMissing, setCacheMissing] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    try {
      const raw = sessionStorage.getItem(END_CACHE_KEY(sessionId));
      if (raw) {
        setResult(JSON.parse(raw) as EndResponse);
        return;
      }
    } catch {
      // ignore
    }
    setCacheMissing(true);
  }, [sessionId]);

  // 새로고침 등으로 캐시 유실 시 GET으로 복원 (streak 정보 없음)
  const fallbackQ = useQuery({
    queryKey: ['ns-session-detail', sessionId],
    queryFn: () => getSessionDetail(sessionId),
    enabled: cacheMissing,
    retry: false,
  });

  useEffect(() => {
    if (!cacheMissing || !fallbackQ.data) return;
    setResult({
      summary: fallbackQ.data.session?.summary ?? '',
      highlights: fallbackQ.data.highlights ?? { headline: '', learned: [], improved: [] },
      voiceBriefing: fallbackQ.data.voiceBriefing ?? '',
      streakUpdated: {
        current: 0,
        longest: 0,
        totalSessions: 0,
        totalNodesLearned: 0,
        isNewRecord: false,
      },
    });
  }, [cacheMissing, fallbackQ.data]);

  const onClose = () => {
    try {
      sessionStorage.removeItem(END_CACHE_KEY(sessionId));
    } catch {
      // ignore
    }
    qc.invalidateQueries({ queryKey: ['ns-status'] });
    router.replace('/learning-coach');
  };

  if (!result) {
    if (cacheMissing && fallbackQ.isError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8">
          <p className="text-sm text-muted-foreground">브리핑을 찾을 수 없어요.</p>
          <button
            onClick={() => router.replace('/learning-coach')}
            className="text-sm text-primary underline"
          >
            돌아가기
          </button>
        </div>
      );
    }
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return <BriefingView result={result} onClose={onClose} />;
}
