'use client';

import { use, useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useModelAnswerStudy } from '@/hooks/useModelAnswerStudy';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  BookOpen,
  Mic,
  Square,
  RotateCcw,
  CheckCircle,
  ArrowLeft,
  ChevronsRight,
} from 'lucide-react';

export default function ModelAnswerStudyPage({
  params,
}: {
  params: Promise<{ resumeId: string }>;
}) {
  const { resumeId } = use(params);
  const router = useRouter();
  const {
    phase,
    plan,
    questions,
    currentIndex,
    revealedAnswers,
    userNotes,
    errorMessage,
    goToQuestion,
    nextQuestion,
    prevQuestion,
    toggleReveal,
    revealAll,
    setNote,
  } = useModelAnswerStudy(resumeId);

  const speech = useSpeechRecognition();
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [practicePhase, setPracticePhase] = useState<'idle' | 'recording' | 'done'>('idle');
  const prevIndexRef = useRef(currentIndex);

  // 吏덈Ц ?대룞 ???뚯꽦 ?곹깭 由ъ뀑
  useEffect(() => {
    if (prevIndexRef.current !== currentIndex) {
      prevIndexRef.current = currentIndex;
      speech.stopListening();
      speech.resetTranscript();
      setPracticePhase('idle');
    }
  }, [currentIndex, speech]);

  const startRecording = useCallback(() => {
    speech.resetTranscript();
    speech.startListening();
    setPracticePhase('recording');
  }, [speech]);

  const stopRecording = useCallback(() => {
    speech.stopListening();
    setPracticePhase('done');
    setNote(currentIndex, speech.transcript);
  }, [speech, currentIndex, setNote]);

  const retryRecording = useCallback(() => {
    speech.resetTranscript();
    speech.startListening();
    setPracticePhase('recording');
  }, [speech]);

  if (phase === 'loading') {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="text-lg font-medium">吏덈Ц怨?紐⑤쾾?듭븞???앹꽦?섍퀬 ?덉뒿?덈떎...</p>
          <p className="text-sm text-muted-foreground">
            ?대젰?쒕? 遺꾩꽍?섏뿬 留욎땄??硫댁젒 吏덈Ц怨?紐⑤쾾?듭븞??以鍮?以묒엯?덈떎
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <p className="text-lg font-medium text-destructive">?ㅻ쪟媛 諛쒖깮?덉뒿?덈떎</p>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <Button variant="outline" onClick={() => router.push('/interview/model-answer')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            ?뚯븘媛湲?          </Button>
        </div>
      </div>
    );
  }

  const currentQuestion = questions[currentIndex];
  const isRevealed = revealedAnswers.has(currentIndex);
  const currentNote = userNotes.get(currentIndex) || '';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">紐⑤쾾?듭븞 ?숈뒿</h1>
          <p className="text-sm text-muted-foreground">
            吏덈Ц??蹂닿퀬 ?듬????앷컖???? 紐⑤쾾?듭븞???뺤씤?섏꽭??          </p>
        </div>
        <Button variant="outline" onClick={() => router.push('/interview/model-answer')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          ?ㅼ떆 ?ㅼ젙
        </Button>
      </div>

      {/* Interview Plan */}
      {plan && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <Badge variant="secondary">{plan.type}</Badge>
            <Badge variant="outline">{plan.difficulty}</Badge>
            {plan.categories.map((cat) => (
              <Badge key={cat} variant="outline">
                {cat}
              </Badge>
            ))}
            <span className="text-sm text-muted-foreground">
              珥?{questions.length}媛?吏덈Ц
            </span>
          </CardContent>
        </Card>
      )}

      {/* Question Navigation */}
      <div className="flex flex-wrap items-center gap-2">
        {questions.map((_, i) => (
          <Button
            key={i}
            size="sm"
            variant={i === currentIndex ? 'default' : revealedAnswers.has(i) ? 'secondary' : 'outline'}
            className="h-8 w-8 p-0"
            onClick={() => goToQuestion(i)}
          >
            {i + 1}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={revealAll}
        >
          <ChevronsRight className="mr-1 h-4 w-4" />
          ?꾩껜 怨듦컻
        </Button>
      </div>

      {/* Question Card */}
      {currentQuestion && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BookOpen className="h-5 w-5 text-primary" />
                吏덈Ц {currentIndex + 1}
                <Badge variant="outline" className="ml-2 text-xs font-normal">
                  {currentQuestion.category}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg leading-relaxed">{currentQuestion.text}</p>
            </CardContent>
          </Card>

          {/* Voice Practice Section */}
          <Card>
            <CardHeader
              className="cursor-pointer"
              onClick={() => setPracticeOpen(!practiceOpen)}
            >
              <CardTitle className="flex items-center gap-2 text-base">
                <Mic className="h-4 w-4" />
                ???듬? 留먰빐蹂닿린
                <span className="text-xs font-normal text-muted-foreground">(?좏깮?ы빆)</span>
                <ChevronRight
                  className={`ml-auto h-4 w-4 transition-transform ${practiceOpen ? 'rotate-90' : ''}`}
                />
              </CardTitle>
            </CardHeader>
            {practiceOpen && (
              <CardContent className="space-y-4">
                {practicePhase === 'idle' && (
                  <div className="flex flex-col items-center gap-3 py-4">
                    <Button
                      size="lg"
                      className="h-16 w-16 rounded-full"
                      onClick={startRecording}
                      disabled={!speech.isSupported}
                    >
                      <Mic className="h-6 w-6" />
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      {speech.isSupported
                        ? '버튼을 눌러 답변을 말해보세요'
                        : 'Chrome ?먮뒗 Edge 釉뚮씪?곗??먯꽌 ?ъ슜 媛?ν빀?덈떎'}
                    </p>
                    {currentNote && (
                      <div className="w-full rounded-lg bg-muted p-3">
                        <p className="text-sm leading-relaxed">{currentNote}</p>
                      </div>
                    )}
                  </div>
                )}

                {practicePhase === 'recording' && (
                  <div className="space-y-3">
                    <div className="min-h-[80px] rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30">
                      <p className="leading-relaxed">
                        {speech.transcript}
                        {speech.interimTranscript && (
                          <span className="text-muted-foreground">{speech.interimTranscript}</span>
                        )}
                        {!speech.transcript && !speech.interimTranscript && (
                          <span className="text-muted-foreground">?ｊ퀬 ?덉뒿?덈떎...</span>
                        )}
                      </p>
                    </div>
                    <div className="flex justify-center">
                      <Button
                        size="lg"
                        variant="destructive"
                        className="h-14 w-14 rounded-full"
                        onClick={stopRecording}
                      >
                        <Square className="h-5 w-5" />
                      </Button>
                    </div>
                  </div>
                )}

                {practicePhase === 'done' && (
                  <div className="space-y-3">
                    <div className="min-h-[80px] rounded-lg bg-muted p-4">
                      <p className="leading-relaxed">
                        {currentNote || '(?뚯꽦???몄떇?섏? ?딆븯?듬땲??'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={retryRecording}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" />
                      ?ㅼ떆 留먰븯湲?                    </Button>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Reveal Button / Model Answer */}
          {!isRevealed ? (
            <Button
              className="w-full"
              size="lg"
              onClick={() => toggleReveal(currentIndex)}
            >
              <Eye className="mr-2 h-4 w-4" />
              紐⑤쾾?듭븞 蹂닿린
            </Button>
          ) : (
            <div className="space-y-4">
              {/* Model Answer */}
              <Card className="border-green-500/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base text-green-700 dark:text-green-400">
                    <CheckCircle className="h-4 w-4" />
                    紐⑤쾾?듭븞
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="leading-relaxed">{currentQuestion.modelAnswer}</p>
                </CardContent>
              </Card>

              {/* Key Points */}
              {currentQuestion.keyPoints?.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <span className="text-sm font-medium">?듭떖 ?ъ씤??</span>
                  {currentQuestion.keyPoints.map((point, i) => (
                    <Badge key={i} variant="secondary">
                      {point}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Answer Tips */}
              {currentQuestion.answerTips?.length > 0 && (
                <Card className="bg-green-50 dark:bg-green-950/20">
                  <CardHeader>
                    <CardTitle className="text-sm text-green-700 dark:text-green-400">
                      ???듬???醫뗭? ?댁쑀
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1">
                      {currentQuestion.answerTips.map((tip, i) => (
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
                ?듭븞 ?④린湲?              </Button>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between pt-2">
            <Button
              variant="outline"
              onClick={prevQuestion}
              disabled={currentIndex === 0}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              ?댁쟾 吏덈Ц
            </Button>
            <span className="text-sm text-muted-foreground">
              {currentIndex + 1} / {questions.length}
            </span>
            <Button
              variant="outline"
              onClick={nextQuestion}
              disabled={currentIndex === questions.length - 1}
            >
              ?ㅼ쓬 吏덈Ц
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

