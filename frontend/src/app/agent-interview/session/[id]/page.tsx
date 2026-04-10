"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AgentInterviewPanel } from "@/components/agent-interview/agent-interview-panel";
import { getAgentSession } from "@/lib/agent-interview-api";

export default function AgentInterviewSessionPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const sessionId = params.id as string;
  const isNewSession = sessionId === "new";

  const resumeId = searchParams.get("resumeId") || "";
  const jobPostingId = searchParams.get("jobPostingId") || undefined;
  const maxQuestions = Number(searchParams.get("maxQuestions")) || 7;
  const textMode = searchParams.get("textMode") === "true";

  // For existing sessions, fetch data
  const { data: session } = useQuery({
    queryKey: ["agent-session", sessionId],
    queryFn: () => getAgentSession(sessionId),
    enabled: !isNewSession,
  });

  // New session requires resumeId
  if (isNewSession && !resumeId) {
    router.replace("/agent-interview/setup");
    return null;
  }

  // New session — show interview panel
  if (isNewSession) {
    return (
      <div className="h-[calc(100vh-4rem)]">
        <AgentInterviewPanel
          resumeId={resumeId}
          jobPostingId={jobPostingId}
          maxQuestions={maxQuestions}
          textMode={textMode}
          onComplete={(sid) => {
            router.push(`/agent-interview/session/${sid}`);
          }}
        />
      </div>
    );
  }

  // Existing session — show report/history
  if (!session) {
    return <div className="flex items-center justify-center h-64">로딩 중...</div>;
  }

  return (
    <div className="container max-w-3xl py-8 space-y-6">
      <h1 className="text-2xl font-bold">면접 결과</h1>
      {session.reportData && (
        <div className="space-y-4">
          <div className="text-4xl font-bold">{session.overallScore}점</div>
          <p>{session.reportData.summary}</p>
          {session.reportData.strengths && (
            <div>
              <h3 className="font-semibold mb-2">강점</h3>
              <ul className="list-disc pl-5 space-y-1">
                {session.reportData.strengths.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {session.reportData.improvements && (
            <div>
              <h3 className="font-semibold mb-2">개선 필요</h3>
              <ul className="list-disc pl-5 space-y-1">
                {session.reportData.improvements.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {session.reportData.recommendations && (
            <div>
              <h3 className="font-semibold mb-2">추천</h3>
              <ul className="list-disc pl-5 space-y-1">
                {session.reportData.recommendations.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="space-y-3">
        <h3 className="font-semibold">대화 기록</h3>
        {session.messages?.map((m: { id: string; role: string; content: string; evaluation?: Record<string, unknown> }, i: number) => (
          <div key={m.id || i} className={`p-3 rounded-lg ${m.role === "user_answer" ? "bg-primary/10 ml-8" : "bg-muted mr-8"}`}>
            <p className="text-sm">{m.content}</p>
            {m.evaluation && (
              <p className="text-xs text-muted-foreground mt-1">점수: {String((m.evaluation as Record<string, number>).overallScore)}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
