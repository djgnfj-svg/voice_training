import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { knowledgeService } from '@/services/knowledge.service';
import { captureError } from '@/lib/error';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    // 최근 학습 기록 (오늘의 학습만)
    const recentSessions = await prisma.activityLog.findMany({
      where: { userId: session.user.id, type: 'NIGHTLY_STUDY' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        items: {
          select: { question: true, extra: true },
          orderBy: { index: 'asc' },
        },
      },
    });

    // 토픽별 숙련도
    const knowledge = await knowledgeService.getUserKnowledge(session.user.id);

    const sessions = recentSessions.map(s => {
      const meta = s.metadata as { mode?: string; summary?: { strengths?: string[]; reviewTopics?: string[] } } | null;
      return {
        id: s.id,
        createdAt: s.createdAt,
        mode: meta?.mode || 'deep',
        questionCount: s.items.length,
        topics: s.items.map(i => {
          const extra = i.extra as { subcategory?: string } | null;
          return extra?.subcategory || '일반';
        }),
        summary: meta?.summary || null,
      };
    });

    const topics = knowledge.map(k => {
      const meta = k.metadata as { weakPoints?: string[]; lastScore?: number; studyCount?: number } | null;
      return {
        topicId: k.topicId,
        topicName: k.topic.name,
        subjectId: k.topic.subjectId,
        proficiency: k.proficiency,
        studyCount: meta?.studyCount ?? (k.successCount + k.failureCount),
        lastScore: meta?.lastScore ?? 0,
        weakPoints: meta?.weakPoints ?? [],
        nextReviewAt: k.nextReviewAt,
      };
    });

    return NextResponse.json({ sessions, topics });
  } catch (error) {
    captureError(error, { context: 'nightly-study-history' });
    return NextResponse.json({ error: '학습 기록을 불러오지 못했습니다' }, { status: 500 });
  }
}
