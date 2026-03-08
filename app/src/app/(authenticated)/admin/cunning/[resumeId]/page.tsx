'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { isAdmin } from '@/lib/admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCunningMode } from '@/hooks/useCunningMode';
import {
  Eye,
  Pause,
  Play,
  Square,
  Send,
  Settings,
  Mic,
  MicOff,
} from 'lucide-react';

export default function CunningModePage() {
  const params = useParams();
  const router = useRouter();
  const { data: session } = useSession();
  const resumeId = params.resumeId as string;

  const [jobPostingText, setJobPostingText] = useState<string | undefined>();
  const [silenceDelay, setSilenceDelay] = useState(2000);
  const [showSettings, setShowSettings] = useState(false);
  const historyEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem('cunning_job_posting');
    if (stored) setJobPostingText(stored);
  }, []);

  const cunning = useCunningMode({
    resumeId,
    jobPostingText,
    silenceDelay,
  });

  // Auto-start on mount
  useEffect(() => {
    if (cunning.isSupported && cunning.phase === 'idle') {
      cunning.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cunning.isSupported]);

  // Auto-scroll history
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cunning.qaHistory]);

  if (!isAdmin(session?.user?.email)) {
    router.push('/dashboard');
    return null;
  }

  const handleStop = () => {
    cunning.stop();
    router.push('/admin/cunning');
  };

  const latestQA = cunning.qaHistory[cunning.qaHistory.length - 1];
  const olderHistory = cunning.qaHistory.slice(0, -1);

  if (!cunning.isSupported) {
    return (
      <div className="mx-auto max-w-4xl py-12 text-center">
        <MicOff className="mx-auto h-12 w-12 text-muted-foreground" />
        <h2 className="mt-4 text-xl font-bold">음성 인식이 지원되지 않습니다</h2>
        <p className="mt-2 text-muted-foreground">
          Chrome 브라우저를 사용해주세요
        </p>
        <Button className="mt-4" onClick={() => router.push('/admin/cunning')}>
          돌아가기
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* Header controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center gap-2">
            {cunning.phase === 'listening' && !cunning.isPaused && (
              <span className="absolute -left-1 -top-1 h-4 w-4 animate-ping rounded-full bg-red-400 opacity-75" />
            )}
            <div
              className={`h-3 w-3 rounded-full ${
                cunning.phase === 'idle'
                  ? 'bg-gray-400'
                  : cunning.isPaused
                    ? 'bg-yellow-400'
                    : cunning.phase === 'listening'
                      ? 'bg-red-500'
                      : 'bg-blue-500'
              }`}
            />
            <span className="text-sm font-medium">
              {cunning.phase === 'idle'
                ? '대기 중'
                : cunning.isPaused
                  ? '일시정지'
                  : cunning.phase === 'listening'
                    ? '듣는 중...'
                    : '답변 생성 중...'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings className="h-4 w-4" />
          </Button>

          {cunning.isPaused ? (
            <Button variant="outline" size="sm" onClick={cunning.resume}>
              <Play className="mr-1 h-4 w-4" />
              재개
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={cunning.pause}>
              <Pause className="mr-1 h-4 w-4" />
              일시정지
            </Button>
          )}

          <Button variant="destructive" size="sm" onClick={handleStop}>
            <Square className="mr-1 h-4 w-4" />
            종료
          </Button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium whitespace-nowrap">
                침묵 감지 딜레이
              </label>
              <input
                type="range"
                min={1000}
                max={5000}
                step={500}
                value={silenceDelay}
                onChange={(e) => setSilenceDelay(Number(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm text-muted-foreground w-12 text-right">
                {(silenceDelay / 1000).toFixed(1)}초
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Real-time transcript */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mic className="h-4 w-4" />
            실시간 음성 인식
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          <div className="min-h-[60px] rounded-lg bg-muted/50 p-3">
            {cunning.transcript || cunning.interimTranscript ? (
              <p className="text-sm">
                {cunning.transcript}
                {cunning.interimTranscript && (
                  <span className="text-muted-foreground">
                    {cunning.interimTranscript}
                  </span>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {cunning.phase === 'listening' && !cunning.isPaused
                  ? '면접관의 질문을 기다리고 있습니다...'
                  : cunning.phase === 'generating'
                    ? '답변 생성 중 — 다음 질문을 기다립니다...'
                    : '시작 대기 중...'}
              </p>
            )}
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => cunning.submitQuestion()}
              disabled={
                cunning.transcript.trim().length < 10 ||
                cunning.phase === 'generating'
              }
            >
              <Send className="mr-1 h-3 w-3" />
              수동 제출
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Latest answer card */}
      {latestQA && (
        <Card className="border-primary/50">
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Eye className="h-4 w-4 text-primary" />
              추천 답변
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="mb-3 rounded-lg bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-1">질문</p>
              <p className="text-sm">{latestQA.question}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">답변</p>
              <p className="text-base leading-relaxed whitespace-pre-wrap">
                {latestQA.answer}
                {latestQA.isStreaming && (
                  <span className="inline-block w-1.5 h-5 ml-0.5 bg-primary animate-pulse align-text-bottom" />
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* History */}
      {olderHistory.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-base">이전 Q&A</CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="max-h-[400px] space-y-4 overflow-y-auto">
              {olderHistory.map((qa, idx) => (
                <div key={idx} className="border-b pb-3 last:border-0 last:pb-0">
                  <p className="text-xs font-medium text-muted-foreground">
                    Q{idx + 1}
                  </p>
                  <p className="text-sm mb-1">{qa.question}</p>
                  <p className="text-xs font-medium text-muted-foreground">답변</p>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {qa.answer}
                  </p>
                </div>
              ))}
              <div ref={historyEndRef} />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
