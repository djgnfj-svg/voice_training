import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mic, History, TrendingUp, FileText } from 'lucide-react';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const [sessionCount, recentSessions, user] = await Promise.all([
    prisma.interviewSession.count({
      where: { userId: session.user.id, status: 'COMPLETED' },
    }),
    prisma.interviewSession.findMany({
      where: { userId: session.user.id, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, type: true, overallScore: true, createdAt: true, categories: true },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { parsedResume: true },
    }),
  ]);

  const avgScore =
    recentSessions.length > 0
      ? Math.round(
          recentSessions
            .filter((s) => s.overallScore !== null)
            .reduce((sum, s) => sum + (s.overallScore || 0), 0) /
            recentSessions.filter((s) => s.overallScore !== null).length
        )
      : 0;

  const hasResume = !!user?.parsedResume;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">대시보드</h1>
        <p className="text-muted-foreground">안녕하세요, {session.user.name}님!</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">총 면접 횟수</CardTitle>
            <History className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sessionCount}회</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">최근 평균 점수</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgScore}점</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">이력서</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{hasResume ? '등록됨' : '미등록'}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">빠른 시작</CardTitle>
            <Mic className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <Link href="/interview/setup">
              <Button size="sm" className="w-full">면접 시작</Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Recent Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>최근 면접 기록</CardTitle>
          <CardDescription>최근 완료한 면접 세션입니다</CardDescription>
        </CardHeader>
        <CardContent>
          {recentSessions.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              <p>아직 면접 기록이 없습니다.</p>
              <Link href="/interview/setup">
                <Button className="mt-4">첫 면접 시작하기</Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recentSessions.map((s) => (
                <Link
                  key={s.id}
                  href={`/interview/report/${s.id}`}
                  className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:bg-accent"
                >
                  <div>
                    <p className="font-medium">
                      {s.type === 'TECHNICAL' ? '기술면접' : s.type === 'BEHAVIORAL' ? '인성면접' : '혼합면접'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {s.categories.join(', ')} | {new Date(s.createdAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold">{s.overallScore ?? '-'}점</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
