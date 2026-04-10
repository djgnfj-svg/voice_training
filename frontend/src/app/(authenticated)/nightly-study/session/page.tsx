'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLearningAgent } from '@/hooks/useLearningAgent';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useTextToSpeech } from '@/hooks/useTextToSpeech';
import { normalizeTranscript } from '@/lib/transcript';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  GraduationCap,
  User,
  Loader2,
  Square,
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  XCircle,
  Lightbulb,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export default function NightlyStudySessionPage() {
  const router = useRouter();
  const agent = useLearningAgent();
  const speech = useSpeechRecognition();
  const tts = useTextToSpeech();

  const startedRef = useRef(false);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Stable refs for timers
  const hadSpeechRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const agentStartRef = useRef(agent.start);
  agentStartRef.current = agent.start;

  const agentSubmitRef = useRef(agent.submitAnswer);
  agentSubmitRef.current = agent.submitAnswer;

  const agentEndEarlyRef = useRef(agent.endEarly);
  agentEndEarlyRef.current = agent.endEarly;

  const agentSetPhaseRef = useRef(agent.setPhase);
  agentSetPhaseRef.current = agent.setPhase;

  // Start session on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    agentStartRef.current();
  }, []);

  // TTS: speak last tutor message, then transition to user-speaking
  const lastTutorMsgRef = useRef<string | null>(null);

  useEffect(() => {
    if (agent.phase !== 'tutor-speaking') return;

    const tutorMessages = agent.messages.filter((m) => m.role === 'tutor');
    const lastTutor = tutorMessages[tutorMessages.length - 1];
    if (!lastTutor || lastTutor.content === lastTutorMsgRef.current) return;
    lastTutorMsgRef.current = lastTutor.content;

    (async () => {
      try {
        await tts.speak(lastTutor.content);
      } catch {
        // TTS failure is non-blocking
      }
      agentSetPhaseRef.current('user-speaking');
      speech.resetTranscript();
      speech.startListening();
    })();
  }, [agent.phase, agent.messages, tts, speech]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agent.messages, agent.phase]);

  // Handle answer submission
  const handleSubmit = useRef(() => {
    speech.stopListening();
    const normalized = normalizeTranscript(speech.transcript.trim());
    agentSubmitRef.current(normalized || '(잘 모르겠어요)');
    speech.resetTranscript();
  });
  handleSubmit.current = () => {
    speech.stopListening();
    const normalized = normalizeTranscript(speech.transcript.trim());
    agentSubmitRef.current(normalized || '(잘 모르겠어요)');
    speech.resetTranscript();
  };

  // Silence auto-submit (3s)
  useEffect(() => {
    if (agent.phase !== 'user-speaking') {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      hadSpeechRef.current = false;
      return;
    }

    const hasContent = !!(speech.transcript || speech.interimTranscript);
    if (hasContent) hadSpeechRef.current = true;
    if (!hadSpeechRef.current) return;

    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    silenceTimerRef.current = setTimeout(() => {
      if (!speech.interimTranscript) {
        handleSubmit.current();
      }
    }, 3000);

    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, [agent.phase, speech.transcript, speech.interimTranscript]);

  // Inactivity auto-end (3 min)
  useEffect(() => {
    const isActive =
      agent.phase === 'user-speaking' || agent.phase === 'tutor-speaking';
    if (!isActive) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      return;
    }

    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);

    inactivityTimerRef.current = setTimeout(() => {
      agentEndEarlyRef.current();
    }, 3 * 60 * 1000);

    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [agent.phase, speech.transcript]);

  // beforeunload prevention
  useEffect(() => {
    const activePhases = [
      'connecting',
      'tutor-speaking',
      'user-speaking',
      'processing',
      'credit-confirm',
      'completing',
    ];
    if (!activePhases.includes(agent.phase)) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [agent.phase]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      tts.stop();
      speech.stopListening();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Renders ---

  // Connecting / loading
  if (agent.phase === 'idle' || agent.phase === 'connecting') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            AI 튜터를 준비하고 있어요...
          </p>
        </div>
      </div>
    );
  }

  // Error
  if (agent.phase === 'error') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <p className="text-sm text-destructive">{agent.error}</p>
          <Button
            variant="outline"
            onClick={() => router.push('/nightly-study')}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            돌아가기
          </Button>
        </div>
      </div>
    );
  }

  // Summary
  if (agent.phase === 'summary' && agent.summary) {
    const s = agent.summary;
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5 text-primary" />
              학습 요약
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {s.topicCovered && (
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  학습 주제
                </p>
                <p className="mt-1">{s.topicCovered}</p>
              </div>
            )}

            {s.keyPoints && s.keyPoints.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-muted-foreground">
                  핵심 포인트
                </p>
                <ul className="space-y-1">
                  {s.keyPoints.map((kp, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-sm"
                    >
                      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      {kp}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {s.strengths && s.strengths.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-muted-foreground">
                  잘한 점
                </p>
                <ul className="space-y-1">
                  {s.strengths.map((str, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-sm text-green-600 dark:text-green-400"
                    >
                      <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {str}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {s.weaknesses && s.weaknesses.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-muted-foreground">
                  보완할 점
                </p>
                <ul className="space-y-1">
                  {s.weaknesses.map((w, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400"
                    >
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {s.nextTopicSuggestion && (
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-sm font-medium">다음에 학습하면 좋을 주제</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {s.nextTopicSuggestion}
                </p>
              </div>
            )}

            {s.encouragement && (
              <p className="text-center text-sm text-muted-foreground italic">
                {s.encouragement}
              </p>
            )}

            <Button
              className="w-full"
              onClick={() => router.push('/nightly-study')}
            >
              돌아가기
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Completing
  if (agent.phase === 'completing') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            학습을 마무리하고 있어요...
          </p>
        </div>
      </div>
    );
  }

  // Main session UI
  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5 text-primary" />
          <span className="text-sm font-medium">AI 튜터</span>
          {agent.isFreeSession && (
            <Badge variant="secondary" className="text-xs">
              무료
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setShowExitDialog(true)}
          disabled={agent.phase === 'processing'}
        >
          <Square className="mr-1 h-3 w-3" />
          그만하기
        </Button>
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {agent.messages.map((msg, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-3',
              msg.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            {msg.role === 'tutor' && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <GraduationCap className="h-4 w-4 text-primary" />
              </div>
            )}
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : msg.phase === 'credit_prompt'
                    ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                    : 'bg-muted',
              )}
            >
              {msg.content}
            </div>
            {msg.role === 'user' && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                <User className="h-4 w-4 text-muted-foreground" />
              </div>
            )}
          </div>
        ))}

        {/* Processing indicator */}
        {agent.phase === 'processing' && (
          <div className="flex gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <GraduationCap className="h-4 w-4 text-primary" />
            </div>
            <div className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              생각하는 중...
            </div>
          </div>
        )}

        {/* Real-time voice input */}
        {agent.phase === 'user-speaking' &&
          (speech.transcript || speech.interimTranscript) && (
            <div className="flex gap-3 justify-end">
              <div className="max-w-[80%] rounded-2xl bg-primary/50 px-4 py-2.5 text-sm text-primary-foreground">
                <span>{speech.transcript}</span>
                {speech.interimTranscript && (
                  <span className="opacity-60">{speech.interimTranscript}</span>
                )}
              </div>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                <User className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
          )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom controls */}
      <div className="border-t bg-card p-4">
        {/* TTS speaking indicator */}
        {agent.phase === 'tutor-speaking' && tts.isSpeaking && (
          <div className="mb-3 flex items-center justify-center gap-2 text-sm text-primary">
            <div className="flex gap-0.5">
              <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
            </div>
            튜터가 말하고 있어요...
          </div>
        )}

        {/* Listening indicator */}
        {agent.phase === 'user-speaking' && (
          <div className="mb-3 text-center">
            {speech.isListening ? (
              <p className="text-sm text-primary">듣고 있어요...</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                잠시 후 답변을 시작할 수 있어요...
              </p>
            )}
            {hadSpeechRef.current &&
              speech.transcript &&
              !speech.interimTranscript && (
                <p className="mt-1 text-xs text-muted-foreground">
                  침묵이 감지되면 자동으로 제출됩니다
                </p>
              )}
          </div>
        )}

        {/* User speaking: manual submit */}
        {agent.phase === 'user-speaking' && (
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => handleSubmit.current()}
            >
              답변 완료
            </Button>
          </div>
        )}

        {/* Credit confirm buttons */}
        {agent.phase === 'credit-confirm' && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={agent.declineCredit}
            >
              마치기
            </Button>
            <Button className="flex-1" onClick={agent.confirmCredit}>
              계속할게요
            </Button>
          </div>
        )}

        {/* Processing */}
        {agent.phase === 'processing' && (
          <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            튜터가 답변을 분석하고 있어요...
          </div>
        )}
      </div>

      {/* Exit confirmation dialog */}
      <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>학습을 그만할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              현재까지의 학습 내용은 저장됩니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>계속하기</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                tts.stop();
                speech.stopListening();
                agent.endEarly();
              }}
            >
              그만하기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
