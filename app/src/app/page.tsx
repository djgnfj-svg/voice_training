import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Briefcase, Mic, FileText, TrendingUp, Target, MessageSquare } from 'lucide-react';

const features = [
  {
    icon: Target,
    title: '채용 공고 맞춤 질문',
    description: '채용 공고를 분석하여 해당 포지션에 최적화된 면접 질문을 생성합니다.',
  },
  {
    icon: Mic,
    title: '음성 기반 면접',
    description: 'AI 면접관과 실제처럼 음성으로 대화하며 면접을 연습합니다.',
  },
  {
    icon: MessageSquare,
    title: '실시간 피드백',
    description: '각 답변에 대한 즉각적인 평가와 구체적인 피드백을 제공합니다.',
  },
  {
    icon: FileText,
    title: '종합 리포트',
    description: '점수, 모범답안, 개선점을 포함한 상세한 면접 리포트를 생성합니다.',
  },
  {
    icon: TrendingUp,
    title: '성장 추적',
    description: '면접 기록을 저장하고 시간에 따른 성장 추이를 확인합니다.',
  },
  {
    icon: Briefcase,
    title: '이력서 매칭',
    description: '이력서와 채용 공고를 비교 분석하여 강점과 약점을 파악합니다.',
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Hero Section */}
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Briefcase className="h-6 w-6 text-primary" />
            <span className="text-lg font-bold">면접 코치</span>
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
            AI와 함께하는
            <br />
            <span className="text-primary">IT 면접 완벽 대비</span>
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-lg text-muted-foreground">
            채용 공고를 붙여넣으면 맞춤 질문이 생성됩니다.
            음성으로 답변하고, 실시간 피드백과 종합 리포트를 받아보세요.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/dashboard">
              <Button size="lg">바로 시작하기</Button>
            </Link>
          </div>
        </section>

        {/* Features */}
        <section className="border-t bg-muted/50 py-24">
          <div className="container mx-auto px-4">
            <h2 className="mb-12 text-center text-3xl font-bold">주요 기능</h2>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {features.map((feature) => (
                <Card key={feature.title}>
                  <CardContent className="pt-6">
                    <feature.icon className="mb-4 h-10 w-10 text-primary" />
                    <h3 className="mb-2 text-lg font-semibold">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground">{feature.description}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>AI 면접 코치 - IT/개발 직무 면접 대비 서비스</p>
      </footer>
    </div>
  );
}
