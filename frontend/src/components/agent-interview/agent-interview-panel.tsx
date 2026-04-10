'use client';

import { useRef, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import {
  Loader2, Send, Volume2, VolumeX, Mic, SkipForward, ArrowLeft, CheckCircle,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useAgentInterview } from '@/hooks/useAgentInterview';
import { useTextToSpeech } from '@/hooks/useTextToSpeech';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { normalizeTranscript } from '@/lib/transcript';

interface AgentInterviewPanelProps {
  resumeId: string;
  jobPostingId?: string;
  maxQuestions?: number;
  onComplete?: (sessionId: string) => void;
}

export function AgentInterviewPanel({
  resumeId,
  jobPostingId,
  maxQuestions = 7,
  onComplete,
}: AgentInterviewPanelProps) {
  const {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions: maxQ,
    report,
    error,
    start,
    submitAnswer,
    skip,
    endEarly,
  } = useAgentInterview();

  const tts = useTextToSpeech();
  const speech = useSpeechRecognition();
  const [showExitDialog, setShowExitDialog] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const lastSpokenRef = useRef('');

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, phase]);

  // Start interview on mount (once)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start({ resumeId, jobPostingId, maxQuestions, textMode: false });
  }, [resumeId, jobPostingId, maxQuestions, start]);

  // Auto-speak questions, then start listening
  useEffect(() => {
    if (phase !== 'waiting_answer') return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return;
    if (lastMsg.role !== 'agent_question' && lastMsg.role !== 'agent_followup') return;
    if (lastMsg.content === lastSpokenRef.current) return;
    lastSpokenRef.current = lastMsg.content;

    (async () => {
      try {
        await tts.speak(lastMsg.content);
      } catch {}
      // Start listening after TTS finishes
      speech.resetTranscript();
      speech.startListening();
    })();
  }, [phase, messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop listening when leaving waiting_answer phase
  useEffect(() => {
    if (phase !== 'waiting_answer' && speech.isListening) {
      speech.stopListening();
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = () => {
    const transcript = normalizeTranscript(speech.transcript);
    if (!transcript) return;
    tts.stop();
    speech.stopListening();
    submitAnswer(transcript);
    speech.resetTranscript();
  };

  const handleSkip = () => {
    tts.stop();
    speech.stopListening();
    speech.resetTranscript();
    skip();
  };

  const handleExit = () => {
    tts.stop();
    speech.stopListening();
    endEarly();
  };

  const isProcessing = [
    'loading_profile',
    'generating_question',
    'evaluating',
    'generating_followup',
    'generating_report',
  ].includes(phase);

  const progress = maxQ > 0 ? (questionCount / maxQ) * 100 : 0;

  // Get current question text
  const currentQuestion = [...messages].reverse().find(
    m => m.role === 'agent_question' || m.role === 'agent_followup'
  );

  // Get last evaluation
  const lastEvaluation = [...messages].reverse().find(m => m.role === 'agent_evaluation');

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <Mic className="h-5 w-5 text-primary" />
          <span className="font-bold">보이스프렙</span>
        </Link>
        <Button variant="ghost" size="sm" onClick={() => setShowExitDialog(true)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          면접 나가기
        </Button>
      </div>

      {/* Progress + Volume */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            질문 {questionCount} / {maxQ}
          </span>
          <div className="flex items-center gap-2">
            <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={tts.volume}
              onChange={(e) => tts.setVolume(Number(e.target.value))}
              className="h-1 w-20 cursor-pointer accent-primary"
            />
            <span className="text-xs text-muted-foreground w-8">
              {Math.round(tts.volume * 100)}%
            </span>
          </div>
        </div>
        <Progress value={progress} />
      </div>

      {/* Current Question */}
      {currentQuestion && phase !== 'completed' && (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-center justify-between mb-3">
              <Badge variant="outline">
                Q{currentQuestion.questionNumber}
                {currentQuestion.followUpRound ? ` 꼬리질문 ${currentQuestion.followUpRound}` : ''}
              </Badge>
              {tts.isSpeaking && (
                <Button variant="ghost" size="icon" onClick={tts.stop} className="h-8 w-8">
                  <VolumeX className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-lg leading-relaxed">{currentQuestion.content}</p>
          </CardContent>
        </Card>
      )}

      {/* Phase Controls */}
      <Card>
        <CardContent className="py-6">
          {/* Loading phases */}
          {isProcessing && (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                {phase === 'loading_profile' && '프로필 분석 중...'}
                {phase === 'generating_question' && '질문 생성 중...'}
                {phase === 'evaluating' && '답변을 평가하고 있습니다...'}
                {phase === 'generating_followup' && '꼬리질문 생성 중...'}
                {phase === 'generating_report' && '리포트 생성 중...'}
              </p>
            </div>
          )}

          {/* TTS playing */}
          {phase === 'waiting_answer' && tts.isSpeaking && !speech.isListening && (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Volume2 className="h-8 w-8 animate-pulse text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">질문을 읽고 있습니다...</p>
            </div>
          )}

          {/* Listening - voice recording */}
          {phase === 'waiting_answer' && speech.isListening && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 ring-4 ring-red-100/50 animate-pulse dark:bg-red-900/30 dark:ring-red-900/30">
                  <Mic className="h-8 w-8 text-red-500 dark:text-red-400" />
                </div>
                <p className="text-sm font-medium text-red-500">녹음 중...</p>
              </div>

              {/* Live transcript */}
              <div className="min-h-[100px] rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">실시간 전사:</p>
                <p className="mt-2">
                  {normalizeTranscript(speech.transcript)}
                  <span className="text-muted-foreground">{speech.interimTranscript}</span>
                </p>
              </div>

              <div className="flex items-center justify-center gap-3">
                <Button variant="outline" onClick={handleSkip}>
                  <SkipForward className="mr-2 h-4 w-4" />
                  건너뛰기
                </Button>
                <Button onClick={handleSubmit} disabled={!speech.transcript}>
                  <Send className="mr-2 h-4 w-4" />
                  답변 제출
                </Button>
              </div>
            </div>
          )}

          {/* Waiting for TTS to finish, not yet listening */}
          {phase === 'waiting_answer' && !tts.isSpeaking && !speech.isListening && (
            <div className="flex flex-col items-center gap-4">
              <p className="text-sm text-muted-foreground">마이크 준비 중...</p>
            </div>
          )}

          {/* Last evaluation display */}
          {lastEvaluation?.evaluation && phase === 'waiting_answer' && (
            <div className="mt-4 pt-4 border-t space-y-3">
              <div className="flex items-center gap-3">
                {(() => {
                  const score = (lastEvaluation.evaluation as Record<string, number>).overallScore;
                  return (
                    <>
                      <div className={cn(
                        'flex h-12 w-12 items-center justify-center rounded-full',
                        score >= 80 ? 'bg-green-100 dark:bg-green-900/30' :
                        score >= 60 ? 'bg-blue-100 dark:bg-blue-900/30' :
                        score >= 40 ? 'bg-amber-100 dark:bg-amber-900/30' :
                        'bg-red-100 dark:bg-red-900/30'
                      )}>
                        <span className={cn(
                          'text-lg font-bold',
                          score >= 80 ? 'text-green-600 dark:text-green-400' :
                          score >= 60 ? 'text-blue-600 dark:text-blue-400' :
                          score >= 40 ? 'text-amber-600 dark:text-amber-400' :
                          'text-red-600 dark:text-red-400'
                        )}>
                          {score}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium">이전 답변: {score}/100</p>
                        <p className="text-sm text-muted-foreground">
                          {(lastEvaluation.evaluation as Record<string, string>).briefFeedback}
                        </p>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-destructive text-sm text-center">{error}</div>
          )}

          {/* Completed */}
          {phase === 'completed' && (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <p className="font-medium">면접이 완료되었습니다</p>
              <Button
                className="w-full"
                onClick={() => sessionId && onComplete?.(sessionId)}
              >
                리포트 확인하기
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Exit confirmation dialog */}
      <Dialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>면접을 나가시겠습니까?</DialogTitle>
            <DialogDescription>
              현재까지의 답변은 저장되어 있습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outline" onClick={() => setShowExitDialog(false)}>
              계속하기
            </Button>
            <Button variant="destructive" onClick={handleExit}>
              나가기
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div ref={messagesEndRef} />
    </div>
  );
}
