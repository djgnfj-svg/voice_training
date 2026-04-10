import { createSSEFromPost } from "./agent-interview-api";

export interface LearningRespondParams {
  sessionId: string;
  answer: string;
  creditConfirmed?: boolean;
}

export function startLearningSession() {
  return createSSEFromPost("/api/nightly-study/start", {});
}

export function respondToLearning(params: LearningRespondParams) {
  return createSSEFromPost(
    `/api/nightly-study/${params.sessionId}/respond`,
    {
      answer: params.answer,
      credit_confirmed: params.creditConfirmed ?? false,
    }
  );
}

export function endLearningSession(sessionId: string) {
  return createSSEFromPost(`/api/nightly-study/${sessionId}/end`, {});
}

export async function getLearningStatus(): Promise<{ dailyLimitReached: boolean }> {
  const res = await fetch("/api/nightly-study/status", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch status");
  return res.json();
}
