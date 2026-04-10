// frontend/src/components/agent-interview/agent-interview-panel.tsx
"use client";

import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Send } from "lucide-react";
import { ChatMessage } from "./chat-message";
import { useAgentInterview } from "@/hooks/useAgentInterview";

interface AgentInterviewPanelProps {
  resumeId: string;
  jobPostingId?: string;
  maxQuestions?: number;
  textMode?: boolean;
  onComplete?: (sessionId: string) => void;
}

export function AgentInterviewPanel({
  resumeId,
  jobPostingId,
  maxQuestions = 7,
  textMode = false,
  onComplete,
}: AgentInterviewPanelProps) {
  const {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions: maxQ,
    report,
    error,
    start,
    submitAnswer,
    endEarly,
  } = useAgentInterview();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const startedRef = useRef(false);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Start interview on mount (once)
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start({ resumeId, jobPostingId, maxQuestions, textMode });
  }, [resumeId, jobPostingId, maxQuestions, textMode, start]);

  const handleTextSubmit = () => {
    const text = textInputRef.current?.value.trim();
    if (!text || phase !== "waiting_answer") return;
    submitAnswer(text);
    if (textInputRef.current) textInputRef.current.value = "";
  };

  const isProcessing = [
    "loading_profile",
    "generating_question",
    "evaluating",
    "generating_followup",
    "generating_report",
  ].includes(phase);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <h2 className="font-semibold">AI 코치 면접</h2>
          <p className="text-xs text-muted-foreground">
            질문 {questionCount} / {maxQ}
          </p>
        </div>
        {phase !== "completed" && (
          <Button variant="outline" size="sm" onClick={endEarly}>
            면접 종료
          </Button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}

        {isProcessing && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">
              {phase === "loading_profile" && "프로필 분석 중..."}
              {phase === "generating_question" && "질문 생성 중..."}
              {phase === "evaluating" && "답변 평가 중..."}
              {phase === "generating_followup" && "꼬리질문 생성 중..."}
              {phase === "generating_report" && "리포트 생성 중..."}
            </span>
          </div>
        )}

        {error && (
          <div className="text-destructive text-sm">{error}</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {phase === "waiting_answer" && (
        <div className="border-t p-4">
          {textMode ? (
            <div className="flex gap-2">
              <textarea
                ref={textInputRef}
                className="flex-1 min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm resize-none"
                placeholder="답변을 입력하세요..."
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleTextSubmit();
                  }
                }}
              />
              <Button onClick={handleTextSubmit} size="icon">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center">
              음성 답변 기능은 기존 마이크 훅과 연동하여 구현됩니다.
              텍스트 모드로 전환하려면 설정에서 textMode를 활성화하세요.
            </p>
          )}
        </div>
      )}

      {/* Complete */}
      {phase === "completed" && report && (
        <div className="border-t p-4">
          <Button
            className="w-full"
            onClick={() => sessionId && onComplete?.(sessionId)}
          >
            리포트 확인하기
          </Button>
        </div>
      )}
    </div>
  );
}
