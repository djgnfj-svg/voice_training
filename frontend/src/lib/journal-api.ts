// frontend/src/lib/journal-api.ts
import { createSSEFromPost } from "@/lib/agent-interview-api";

export interface JournalStartResponse {
  sessionId: string;
  messageCount: number;
  freeMessagesUsed: number;
}

export interface JournalSessionSummary {
  id: string;
  summary: string | null;
  messageCount: number;
  status: string;
  createdAt: string;
}

export interface JournalEndResponse {
  status: string;
  summary: {
    summary: string;
    highlights: string[];
  } | null;
}

export async function startJournalSession(): Promise<JournalStartResponse> {
  const res = await fetch("/api/journal/start", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "세션 시작 실패" }));
    throw new Error(data.detail?.error || data.error || "세션 시작 실패");
  }
  return res.json();
}

export function sendJournalMessage(sessionId: string, message: string) {
  return createSSEFromPost(`/api/journal/${sessionId}/message`, { message });
}

export async function endJournalSession(sessionId: string): Promise<JournalEndResponse> {
  const res = await fetch(`/api/journal/${sessionId}/end`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "세션 종료 실패" }));
    throw new Error(data.detail?.error || data.error || "세션 종료 실패");
  }
  return res.json();
}

export async function getJournalHistory(): Promise<JournalSessionSummary[]> {
  const res = await fetch("/api/journal/history", {
    credentials: "include",
  });
  if (!res.ok) throw new Error("히스토리 조회 실패");
  return res.json();
}
