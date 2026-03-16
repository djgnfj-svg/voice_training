'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useNightlyStudy } from '@/hooks/useNightlyStudy';
import { ConversationView } from '@/components/nightly-study/conversation-view';
import { StudySummaryCard } from '@/components/nightly-study/study-summary-card';
import { Button } from '@/components/ui/button';
import { Mic, MicOff, SkipForward, Square, Loader2, Moon, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function NightlyStudySessionPage() {
  const router = useRouter();
  const startedRef = useRef(false);

  const {
    phase,
    currentState,
    currentQuestionIndex,
    questions,
    summary,
    error,
    transcript,
    interimTranscript,
    isListening,
    isSpeaking,
    startSession,
    submitAnswer,
    skipAnswer,
    finishEarly,
  } = useNightlyStudy();

  // Start session from sessionStorage config
  useEffect(() => {
    if (startedRef.current) return;
    const configStr = sessionStorage.getItem('nightly_study_config');
    if (!configStr) {
      router.replace('/nightly-study');
      return;
    }
    startedRef.current = true;
    const config = JSON.parse(configStr);
    sessionStorage.removeItem('nightly_study_config');
    startSession(config.categories, config.mode, config.resumeId);
  }, [router, startSession]);

  // Prevent accidental navigation
  useEffect(() => {
    if (phase === 'summary' || phase === 'setup' || phase === 'error') return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase]);

  // Loading state
  if (phase === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">학습 세션을 준비하고 있어요...</p>
        </div>
      </div>
    );
  }

  // Daily limit
  if (phase === 'daily-limit') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <Moon className="h-10 w-10 text-muted-foreground" />
          <p className="text-lg font-semibold">오늘은 이미 학습했어요!</p>
          <Button variant="outline" onClick={() => router.push('/dashboard')}>
            대시보드로 돌아가기
          </Button>
        </div>
      </div>
    );
  }

  // Error state
  if (phase === 'error') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" onClick={() => router.push('/nightly-study')}>
            돌아가기
          </Button>
        </div>
      </div>
    );
  }

  // Summary state
  if (phase === 'summary' && summary) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <StudySummaryCard summary={summary} />
      </div>
    );
  }

  // Main session UI
  const conversation = currentState?.conversation || [];
  const questionLabel = questions.length > 1
    ? `질문 ${currentQuestionIndex + 1} / ${questions.length}`
    : currentState?.question.subcategory || '';

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Moon className="h-5 w-5 text-primary" />
          <span className="text-sm font-medium">오늘의 학습</span>
          {questionLabel && (
            <span className="text-xs text-muted-foreground">— {questionLabel}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={finishEarly}
          disabled={phase === 'processing'}
        >
          <Square className="mr-1 h-3 w-3" />
          그만하기
        </Button>
      </div>

      {/* Conversation area */}
      <ConversationView
        messages={conversation}
        isProcessing={phase === 'processing'}
        interimTranscript={
          phase === 'user-speaking' ? (transcript + interimTranscript) || undefined : undefined
        }
      />

      {/* Bottom panel */}
      <div className="border-t bg-card p-4">
        {/* Tutor speaking indicator */}
        {phase === 'tutor-speaking' && isSpeaking && (
          <div className="mb-3 flex items-center justify-center gap-2 text-sm text-primary">
            <div className="flex gap-0.5">
              <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
            </div>
            튜터가 말하고 있어요...
          </div>
        )}

        {/* User speaking transcript */}
        {phase === 'user-speaking' && (transcript || interimTranscript) && (
          <div className="mb-3 rounded-lg bg-muted/50 p-3 text-sm">
            <span>{transcript}</span>
            {interimTranscript && (
              <span className="text-muted-foreground">{interimTranscript}</span>
            )}
          </div>
        )}

        {/* Auto-submit hint */}
        {phase === 'user-speaking' && transcript && !interimTranscript && (
          <p className="mb-2 text-center text-xs text-muted-foreground">
            침묵이 감지되면 자동으로 제출됩니다
          </p>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {phase === 'user-speaking' && (
            <>
              <Button
                variant="outline"
                className="flex-1"
                onClick={skipAnswer}
              >
                <SkipForward className="mr-2 h-4 w-4" />
                잘 모르겠어요
              </Button>
              <Button
                className="flex-1"
                onClick={submitAnswer}
              >
                {isListening ? (
                  <>
                    <Mic className="mr-2 h-4 w-4 animate-pulse text-red-400" />
                    답변 완료
                  </>
                ) : (
                  <>
                    <MicOff className="mr-2 h-4 w-4" />
                    답변 완료
                  </>
                )}
              </Button>
            </>
          )}

          {phase === 'processing' && (
            <div className="flex w-full items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              튜터가 답변을 분석하고 있어요...
            </div>
          )}

          {phase === 'tutor-speaking' && !isSpeaking && (
            <div className="flex w-full items-center justify-center py-2 text-sm text-muted-foreground">
              잠시 후 답변을 시작할 수 있어요...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
