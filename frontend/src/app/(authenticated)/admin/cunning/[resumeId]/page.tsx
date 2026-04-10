'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { isAdmin } from '@/lib/admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useCunningMode, type CunningQA } from '@/hooks/useCunningMode';
import {
  Eye,
  Pause,
  Play,
  Square,
  Send,
  Settings,
  Mic,
  MicOff,
  Keyboard,
} from 'lucide-react';

type InputMode = 'voice' | 'text';

export default function CunningModePage() {
  const params = useParams();
  const router = useRouter();
  const { data: session } = useSession();
  const resumeId = params.resumeId as string;

  const [jobPostingText, setJobPostingText] = useState<string | undefined>();
  const [silenceDelay, setSilenceDelay] = useState(2000);
  const [showSettings, setShowSettings] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('voice');
  const [textQuestion, setTextQuestion] = useState('');
  const [textQaHistory, setTextQaHistory] = useState<CunningQA[]>([]);
  const [isTextStreaming, setIsTextStreaming] = useState(false);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const textAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem('cunning_job_posting');
    if (stored) setJobPostingText(stored);
  }, []);

  const cunning = useCunningMode({
    resumeId,
    jobPostingText,
    silenceDelay,
  });

  const startRef = useRef(cunning.start);
  startRef.current = cunning.start;

  // Auto-start voice on mount
  useEffect(() => {
    if (inputMode === 'voice' && cunning.isSupported && cunning.phase === 'idle') {
      startRef.current();
    }
  }, [cunning.isSupported, cunning.phase, inputMode]);

  // Get combined QA history for display
  const qaHistory = inputMode === 'voice' ? cunning.qaHistory : textQaHistory;

  // Auto-scroll history
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [qaHistory]);

  // Text mode: submit question
  const submitTextQuestion = useCallback(async () => {
    const question = textQuestion.trim();
    if (question.length < 2 || isTextStreaming) return;

    setTextQuestion('');
    setIsTextStreaming(true);
    setTextQaHistory((prev) => [...prev, { question, answer: '', isStreaming: true }]);

    textAbortRef.current = new AbortController();

    try {
      const historyForApi = textQaHistory.slice(-3).map((qa) => ({
        question: qa.question,
        answer: qa.answer,
      }));

      const res = await fetch('/api/cunning/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeId,
          question,
          jobPostingText: jobPostingText || undefined,
          conversationHistory: historyForApi.length > 0 ? historyForApi : undefined,
        }),
        signal: textAbortRef.current.signal,
      });

      if (!res.ok) throw new Error('API 요청 실패');

      const reader = res.body?.getReader();
      if (!reader) throw new Error('스트림 읽기 실패');

      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              accumulated += parsed.text;
              setTextQaHistory((prev) => {
                const updated = [...prev];
                const idx = updated.length - 1;
                if (idx >= 0) updated[idx] = { ...updated[idx], answer: accumulated };
                return updated;
              });
            }
          } catch {
            // skip
          }
        }
      }

      setTextQaHistory((prev) => {
        const updated = [...prev];
        const idx = updated.length - 1;
        if (idx >= 0) updated[idx] = { ...updated[idx], isStreaming: false };
        return updated;
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setTextQaHistory((prev) => {
        const updated = [...prev];
        const idx = updated.length - 1;
        if (idx >= 0) {
          updated[idx] = {
            ...updated[idx],
            answer: updated[idx].answer || '답변 생성에 실패했습니다.',
            isStreaming: false,
          };
        }
        return updated;
      });
    } finally {
      textAbortRef.current = null;
      setIsTextStreaming(false);
    }
  }, [textQuestion, isTextStreaming, textQaHistory, resumeId, jobPostingText]);

  // Switch mode handler
  const handleModeSwitch = (mode: InputMode) => {
    if (mode === inputMode) return;
    if (inputMode === 'voice') cunning.stop();
    setInputMode(mode);
  };

  if (!isAdmin(session?.user?.email)) {
    router.push('/dashboard');
    return null;
  }

  const handleStop = () => {
    cunning.stop();
    if (textAbortRef.current) textAbortRef.current.abort();
    router.push('/admin/cunning');
  };

  const latestQA = qaHistory[qaHistory.length - 1];
  const olderHistory = qaHistory.slice(0, -1);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* Header controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {inputMode === 'voice' && (
            <div className="relative flex items-center gap-2">
              {cunning.phase === 'listening' && !cunning.isPaused && (
                <span className="absolute -left-1 -top-1 h-4 w-4 animate-ping rounded-full bg-red-400 opacity-75" />
              )}
              <div
                className={`h-3 w-3 rounded-full ${
                  cunning.phase === 'idle'
                    ? 'bg-gray-400 dark:bg-gray-600'
                    : cunning.isPaused
                      ? 'bg-yellow-400 dark:bg-yellow-500'
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
          )}
          {inputMode === 'text' && (
            <div className="flex items-center gap-2">
              <div className={`h-3 w-3 rounded-full ${isTextStreaming ? 'bg-blue-500' : 'bg-green-500 dark:bg-green-400'}`} />
              <span className="text-sm font-medium">
                {isTextStreaming ? '답변 생성 중...' : '텍스트 입력 대기'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {inputMode === 'voice' && (
            <>
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
            </>
          )}

          <Button variant="destructive" size="sm" onClick={handleStop}>
            <Square className="mr-1 h-4 w-4" />
            종료
          </Button>
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        <button
          onClick={() => handleModeSwitch('voice')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            inputMode === 'voice'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Mic className="h-4 w-4" />
          음성 입력
        </button>
        <button
          onClick={() => handleModeSwitch('text')}
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            inputMode === 'text'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Keyboard className="h-4 w-4" />
          텍스트 입력
        </button>
      </div>

      {/* Settings panel (voice only) */}
      {inputMode === 'voice' && showSettings && (
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

      {/* Voice input */}
      {inputMode === 'voice' && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mic className="h-4 w-4" />
              실시간 음성 인식
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            {!cunning.isSupported ? (
              <div className="flex flex-col items-center gap-2 py-4">
                <MicOff className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  음성 인식이 지원되지 않습니다. 텍스트 입력을 사용해주세요.
                </p>
              </div>
            ) : (
              <>
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
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Text input */}
      {inputMode === 'text' && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Keyboard className="h-4 w-4" />
              질문 입력
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            <Textarea
              placeholder="면접 질문을 입력하세요..."
              value={textQuestion}
              onChange={(e) => setTextQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitTextQuestion();
                }
              }}
              rows={3}
              disabled={isTextStreaming}
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                onClick={submitTextQuestion}
                disabled={textQuestion.trim().length < 2 || isTextStreaming}
              >
                <Send className="mr-1 h-3 w-3" />
                답변 생성
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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
