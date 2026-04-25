export interface TargetNode {
  id: string;
  title: string;
  description: string;
}

export interface StartResponse {
  sessionId: string;
  initialMode: 'onboarding' | 'learning';
  targetNode: TargetNode | null;
  firstMessage: string;
}

export interface StatusResponse {
  streak: {
    current: number;
    longest: number;
    totalSessions: number;
    totalNodesLearned: number;
  };
  hasGoal: boolean;
  todayTargetNode: { title: string; description: string } | null;
  recentSessions: Array<{
    id: string;
    startedAt: string | null;
    endedAt: string | null;
    headline: string;
  }>;
}

export interface Highlights {
  headline: string;
  learned: string[];
  improved: string[];
}

export interface EndResponse {
  summary: string;
  highlights: Highlights;
  voiceBriefing: string;
  streakUpdated: {
    current: number;
    longest: number;
    totalSessions: number;
    totalNodesLearned: number;
    isNewRecord: boolean;
  };
}

export async function startSession(): Promise<StartResponse> {
  const res = await fetch('/api/learning-coach/start', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail?.error || body.error || '세션을 시작할 수 없어요');
  }
  return res.json();
}

export async function endSession(sessionId: string, reason: 'user' | 'ai_suggested' = 'user'): Promise<EndResponse> {
  const res = await fetch(`/api/learning-coach/${sessionId}/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    throw new Error('세션 종료에 실패했어요');
  }
  return res.json();
}

export async function getStatus(): Promise<StatusResponse> {
  const res = await fetch('/api/learning-coach/status');
  if (!res.ok) throw new Error('상태 로드 실패');
  return res.json();
}

export async function setGoal(title: string): Promise<{ goalId: string; seedNodeCount: number }> {
  const res = await fetch('/api/learning-coach/goal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error('목표 저장 실패');
  return res.json();
}

export async function getSessionDetail(id: string) {
  const res = await fetch(`/api/learning-coach/sessions/${id}`);
  if (!res.ok) throw new Error('세션 로드 실패');
  return res.json();
}
