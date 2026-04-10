"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { AgentInterviewPanel } from "@/components/agent-interview/agent-interview-panel";

export default function AgentInterviewSessionPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const resumeId = searchParams.get("resumeId") || "";
  const jobPostingId = searchParams.get("jobPostingId") || undefined;
  const maxQuestions = Number(searchParams.get("maxQuestions")) || 7;
  const textMode = searchParams.get("textMode") === "true";

  if (!resumeId) {
    router.replace("/agent-interview/setup");
    return null;
  }

  return (
    <div className="h-[calc(100vh-4rem)]">
      <AgentInterviewPanel
        resumeId={resumeId}
        jobPostingId={jobPostingId}
        maxQuestions={maxQuestions}
        textMode={textMode}
        onComplete={(sessionId) => {
          router.push(`/agent-interview/session/${sessionId}`);
        }}
      />
    </div>
  );
}
