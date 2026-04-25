'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  endSession,
  getSessionDetail,
  type EndResponse,
  type StartResponse,
  type TargetNode,
} from '@/lib/learning-coach-api';
import { SessionView } from '@/components/learning-coach/session-view';

const START_CACHE_KEY = (id: string) => `ns:start:${id}`;
const END_CACHE_KEY = (id: string) => `ns:end:${id}`;

interface SessionContext {
  sessionId: string;
  firstMessage: string;
  targetNode: TargetNode | null;
}

export default function SessionPage() {
  const router = useRouter();
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [ctx, setCtx] = useState<SessionContext | null>(null);
  const [ctxMissing, setCtxMissing] = useState(false);

  // sessionStorage에서 start 응답 복원 시도
  useEffect(() => {
    if (!sessionId) return;
    let loaded: StartResponse | null = null;
    try {
      const raw = sessionStorage.getItem(START_CACHE_KEY(sessionId));
      if (raw) loaded = JSON.parse(raw) as StartResponse;
    } catch {
      loaded = null;
    }
    if (loaded && loaded.sessionId === sessionId) {
      setCtx({
        sessionId: loaded.sessionId,
        firstMessage: loaded.firstMessage,
        targetNode: loaded.targetNode,
      });
    } else {
      setCtxMissing(true);
    }
  }, [sessionId]);

  // sessionStorage에 없으면 GET으로 복원
  const fallbackQ = useQuery({
    queryKey: ['ns-session-detail', sessionId],
    queryFn: () => getSessionDetail(sessionId),
    enabled: ctxMissing,
    retry: false,
  });

  useEffect(() => {
    if (!ctxMissing || !fallbackQ.data) return;
    const messages = (fallbackQ.data.messages ?? []) as Array<{ role: string; content: string }>;
    const firstAssistant = messages.find((m) => m.role === 'assistant')?.content ?? '';
    setCtx({
      sessionId,
      firstMessage: firstAssistant,
      targetNode: null,
    });
  }, [ctxMissing, fallbackQ.data, sessionId]);

  const endMut = useMutation({
    mutationFn: () => endSession(sessionId),
    onSuccess: (result: EndResponse) => {
      try {
        sessionStorage.setItem(END_CACHE_KEY(sessionId), JSON.stringify(result));
        sessionStorage.removeItem(START_CACHE_KEY(sessionId));
      } catch {
        // 실패해도 브리핑 페이지가 GET으로 fallback
      }
      router.replace(`/learning-coach/briefing/${sessionId}`);
    },
    onError: () => {
      router.replace('/learning-coach');
    },
  });

  const onEnd = useMemo(
    () => async () => {
      await endMut.mutateAsync();
    },
    [endMut],
  );

  if (endMut.isPending) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">오늘 학습을 정리하고 있어요…</p>
      </div>
    );
  }

  if (ctxMissing && fallbackQ.isError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8">
        <p className="text-sm text-muted-foreground">세션을 찾을 수 없어요.</p>
        <button
          onClick={() => router.replace('/learning-coach')}
          className="text-sm text-primary underline"
        >
          돌아가기
        </button>
      </div>
    );
  }

  if (!ctx) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <SessionView
      sessionId={ctx.sessionId}
      firstMessage={ctx.firstMessage}
      currentTopic={ctx.targetNode?.title ?? null}
      onEnd={onEnd}
    />
  );
}
