import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Mic, MessageSquare, TrendingUp, Target, BookOpen, FileText, ArrowRight, CheckCircle, X } from 'lucide-react';

const features = [
  {
    icon: Mic,
    title: '음성 면접 연습',
    description: '타이핑 대신 실제 면접처럼 음성으로 답변하며 연습합니다.',
  },
  {
    icon: MessageSquare,
    title: '꼬리질문 심화',
    description: 'AI가 답변의 약점을 파고드는 꼬리질문으로 깊이를 검증합니다.',
  },
  {
    icon: TrendingUp,
    title: 'AI 실시간 피드백',
    description: '각 답변에 대한 즉각적인 평가와 구체적인 개선 방향을 제공합니다.',
  },
  {
    icon: Target,
    title: '기술 질문 뱅크',
    description: '프론트엔드, 백엔드, 인프라 등 분야별 핵심 질문으로 대비합니다.',
  },
  {
    icon: BookOpen,
    title: '성장 추적',
    description: '면접 기록을 저장하고 시간에 따른 점수 추이를 확인합니다.',
  },
  {
    icon: FileText,
    title: '이력서 매칭',
    description: '이력서와 채용 공고를 분석하여 맞춤 질문을 생성합니다.',
  },
];

const howItWorks = [
  {
    step: '01',
    title: '이력서 업로드',
    description: 'PDF 이력서를 올리면 AI가 기술스택과 프로젝트를 분석합니다.',
  },
  {
    step: '02',
    title: 'AI가 질문 설계',
    description: '이력서와 채용공고를 바탕으로 맞춤 면접 질문을 생성합니다.',
  },
  {
    step: '03',
    title: '음성 답변 + 피드백',
    description: '음성으로 답변하면 AI가 즉시 평가하고 꼬리질문으로 심화합니다.',
  },
];

const comparison = {
  others: [
    '텍스트로 답변 입력',
    '단발성 질문-답변',
    '일반적인 피드백',
    '서류 중심 분석',
  ],
  voiceprep: [
    '실제처럼 음성으로 답변',
    '꼬리질문으로 깊이 검증',
    '구체적 개선 포인트',
    '음성 면접 실전 대비',
  ],
};

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Mic className="h-6 w-6 text-primary" />
            <span className="text-lg font-bold">보이스프렙</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost">로그인</Button>
            </Link>
            <Link href="/login">
              <Button>시작하기</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="container mx-auto px-4 py-24 text-center">
          <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl">
            말하며 준비하는
            <br />
            <span className="bg-gradient-to-r from-primary to-blue-400 bg-clip-text text-transparent">개발자 기술 면접</span>
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground">
            타이핑 대신 진짜 면접처럼 음성으로 답변하세요.
            AI가 꼬리질문으로 깊이를 파고들고, 실시간 피드백으로 성장합니다.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/login">
              <Button size="lg" className="shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all duration-200">
                무료로 시작하기
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>

        {/* Features */}
        <section className="border-t bg-muted/50 py-24">
          <div className="container mx-auto px-4">
            <h2 className="mb-12 text-center text-3xl font-bold">주요 기능</h2>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {features.map((feature) => (
                <Card key={feature.title} className="group">
                  <CardContent className="pt-6">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 transition-colors duration-200 group-hover:bg-primary/15">
                      <feature.icon className="h-6 w-6 text-primary" />
                    </div>
                    <h3 className="mb-2 text-lg font-semibold">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground">{feature.description}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="border-t py-24">
          <div className="container mx-auto px-4">
            <h2 className="mb-12 text-center text-3xl font-bold">이렇게 진행됩니다</h2>
            <div className="grid gap-8 md:grid-cols-3">
              {howItWorks.map((item) => (
                <div key={item.step} className="text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                    <span className="text-2xl font-bold text-primary">{item.step}</span>
                  </div>
                  <h3 className="mb-2 text-lg font-semibold">{item.title}</h3>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Comparison */}
        <section className="border-t bg-muted/50 py-24">
          <div className="container mx-auto px-4">
            <h2 className="mb-12 text-center text-3xl font-bold">텍스트 기반 도구 vs VoicePrep</h2>
            <div className="mx-auto grid max-w-3xl gap-6 md:grid-cols-2">
              <Card className="border-muted-foreground/20">
                <CardContent className="pt-6">
                  <h3 className="mb-4 text-center text-lg font-semibold text-muted-foreground">텍스트 기반 도구</h3>
                  <ul className="space-y-3">
                    {comparison.others.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <X className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              <Card className="border-primary/30 ring-1 ring-primary/10">
                <CardContent className="pt-6">
                  <h3 className="mb-4 text-center text-lg font-semibold text-primary">VoicePrep</h3>
                  <ul className="space-y-3">
                    {comparison.voiceprep.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-sm">
                        <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t py-24 text-center">
          <div className="container mx-auto px-4">
            <h2 className="mb-4 text-3xl font-bold">지금 바로 시작하세요</h2>
            <p className="mb-8 text-lg text-muted-foreground">첫 면접은 무료입니다. 음성으로 연습하며 실력을 키워보세요.</p>
            <Link href="/login">
              <Button size="lg" className="shadow-lg shadow-primary/25">
                무료로 시작하기
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>VoicePrep — 말하며 준비하는 개발자 기술 면접 코치</p>
      </footer>
    </div>
  );
}
