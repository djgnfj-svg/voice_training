// frontend/src/components/agent-interview/chat-message.tsx
"use client";

import { cn } from "@/lib/utils";
import type { AgentMessage } from "@/hooks/useAgentInterview";

interface ChatMessageProps {
  message: AgentMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isAgent = message.role !== "user_answer";

  return (
    <div className={cn("flex w-full", isAgent ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3",
          isAgent
            ? "bg-muted text-foreground"
            : "bg-primary text-primary-foreground",
        )}
      >
        {message.role === "agent_evaluation" && message.evaluation ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">
                {(message.evaluation as Record<string, number>).overallScore}점
              </span>
            </div>
            <p className="text-sm">{message.content}</p>
            {(message.evaluation as Record<string, string>).detailedFeedback && (
              <p className="text-xs opacity-80">
                {(message.evaluation as Record<string, string>).detailedFeedback}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        )}

        {(message.role === "agent_question" || message.role === "agent_followup") &&
          message.questionNumber && (
            <span className="text-xs opacity-50 mt-1 block">
              질문 {message.questionNumber}
              {message.followUpRound ? ` (꼬리질문 ${message.followUpRound})` : ""}
            </span>
          )}
      </div>
    </div>
  );
}
