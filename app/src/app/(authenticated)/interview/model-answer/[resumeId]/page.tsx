'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  useModelAnswerStudy,
  type ModelAnswerQuestion,
} from '@/hooks/useModelAnswerStudy';
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  BookOpen,
  Lightbulb,
  CheckCircle,
  ArrowLeft,
  ChevronsRight,
  Coins,
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

  const [noteOpen, setNoteOpen] = useState(false);

  if (phase === 'loading') {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="text-lg font-medium">질문과 모범답안을 생성하고 있습니다...</p>
          <p className="text-sm text-muted-foreground">
            이력서를 분석하여 맞춤형 면접 질문과 모범답안을 준비 중입니다
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'insufficient_credits') {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <Coins className="h-12 w-12 text-amber-500" />
          <p className="text-lg font-medium">크레딧이 부족합니다</p>
          <p className="text-sm text-muted-foreground">
            모범답안 학습을 이용하려면 크레딧이 필요합니다.
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => router.push('/interview/model-answer')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              돌아가기
            </Button>
            <Button onClick={() => router.push('/credits')}>
              <Coins className="mr-2 h-4 w-4" />
              크레딧 충전
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          <p className="text-lg font-medium text-destructive">오류가 발생했습니다</p>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <Button variant="outline" onClick={() => router.push('/interview/model-answer')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            돌아가기
          </Button>
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
          <h1 className="text-2xl font-bold">모범답안 학습</h1>
          <p className="text-sm text-muted-foreground">
            질문을 보고 답변을 생각한 뒤, 모범답안을 확인하세요
          </p>
        </div>
        <Button variant="outline" onClick={() => router.push('/interview/model-answer')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          다시 설정
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
              총 {questions.length}개 질문
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
          전체 공개
        </Button>
      </div>

      {/* Question Card */}
      {currentQuestion && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BookOpen className="h-5 w-5 text-primary" />
                질문 {currentIndex + 1}
                <Badge variant="outline" className="ml-2 text-xs font-normal">
                  {currentQuestion.category}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg leading-relaxed">{currentQuestion.text}</p>
            </CardContent>
          </Card>

          {/* User Notes Section */}
          <Card>
            <CardHeader
              className="cursor-pointer"
              onClick={() => setNoteOpen(!noteOpen)}
            >
              <CardTitle className="flex items-center gap-2 text-base">
                <Lightbulb className="h-4 w-4" />
                내 답변 작성해보기
                <span className="text-xs font-normal text-muted-foreground">(선택사항)</span>
                <ChevronRight
                  className={`ml-auto h-4 w-4 transition-transform ${noteOpen ? 'rotate-90' : ''}`}
                />
              </CardTitle>
            </CardHeader>
            {noteOpen && (
              <CardContent>
                <Textarea
                  placeholder="이 질문에 대한 나의 답변을 작성해보세요..."
                  value={currentNote}
                  onChange={(e) => setNote(currentIndex, e.target.value)}
                  rows={5}
                />
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
              모범답안 보기
            </Button>
          ) : (
            <div className="space-y-4">
              {/* Model Answer */}
              <Card className="border-green-500/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base text-green-700 dark:text-green-400">
                    <CheckCircle className="h-4 w-4" />
                    모범답안
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="leading-relaxed">{currentQuestion.modelAnswer}</p>
                </CardContent>
              </Card>

              {/* Key Points */}
              {currentQuestion.keyPoints?.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <span className="text-sm font-medium">핵심 포인트:</span>
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
                      이 답변이 좋은 이유
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
                답안 숨기기
              </Button>
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
              이전 질문
            </Button>
            <span className="text-sm text-muted-foreground">
              {currentIndex + 1} / {questions.length}
            </span>
            <Button
              variant="outline"
              onClick={nextQuestion}
              disabled={currentIndex === questions.length - 1}
            >
              다음 질문
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
