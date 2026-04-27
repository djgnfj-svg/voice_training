// frontend/src/hooks/useAgentInterview.ts
import { useCallback, useRef, useState } from "react";
import {
  startAgentInterview,
  submitAgentAnswer,
  skipAgentQuestion,
  endAgentInterview,
  type AgentStartParams,
} from "@/lib/agent-interview-api";

export interface AgentMessage {
  role: "agent_question" | "user_answer" | "agent_evaluation" | "agent_followup";
  content: string;
  evaluation?: Record<string, unknown>;
  questionNumber?: number;
  followUpRound?: number;
  phase?: "scan" | "dive";
  phaseLabel?: string;
}

type Phase =
  | "idle"
  | "loading_profile"
  | "generating_question"
  | "waiting_answer"
  | "evaluating"
  | "generating_followup"
  | "generating_report"
  | "completed"
  | "error"
  | "scan_plan_ready"
  | "dive_plan_ready"
  | "fit_analyzing"
  | "fit_analyzed"
  | "profile_loaded"
  | "updating_profile"
  | (string & {});

export function useAgentInterview() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState(0);
  const [maxQuestions, setMaxQuestions] = useState(7);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<ReturnType<typeof startAgentInterview> | null>(null);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const attachListeners = useCallback(
    (source: ReturnType<typeof startAgentInterview>) => {
      sourceRef.current = source;

      source.addEventListener("status", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setPhase(data.phase as Phase);
        if (typeof data.max_questions === "number") {
          setMaxQuestions(data.max_questions);
        }
      });

      source.addEventListener("session", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setSessionId(data.sessionId);
        setQuestionCount(data.questionCount);
        setMaxQuestions(data.maxQuestions);
      });

      source.addEventListener("question", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        const isFollowup = (data.followUpRound ?? 0) > 0;
        setMessages((prev) => [
          ...prev,
          {
            role: isFollowup ? "agent_followup" : "agent_question",
            content: data.question,
            questionNumber: data.questionNumber,
            followUpRound: data.followUpRound,
            phase: data.phase,
            phaseLabel: data.phaseLabel,
          },
        ]);
        setQuestionCount(data.questionNumber);
        setPhase("waiting_answer");
      });

      source.addEventListener("evaluation", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          {
            role: "agent_evaluation",
            content: data.briefFeedback,
            evaluation: data,
          },
        ]);
      });

      source.addEventListener("action", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        if (typeof data.questionCount === "number") {
          setQuestionCount(data.questionCount);
        }
        if (typeof data.maxQuestions === "number") {
          setMaxQuestions(data.maxQuestions);
        }
        if (data.action === "end") {
          setPhase("generating_report");
        }
      });

      source.addEventListener("complete", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setReport(data.report);
        setPhase("completed");
        cleanup();
      });

      source.addEventListener("error", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setError(data.error || "오류가 발생했습니다");
        } catch {
          setError("연결이 끊어졌습니다");
        }
        setPhase("error");
        cleanup();
      });
    },
    [cleanup],
  );

  const start = useCallback(
    (params: AgentStartParams) => {
      cleanup();
      setMessages([]);
      setReport(null);
      setError(null);
      setPhase("loading_profile");

      const source = startAgentInterview(params);
      attachListeners(source);
    },
    [cleanup, attachListeners],
  );

  const submitAnswer = useCallback(
    (answer: string) => {
      if (!sessionId) return;
      cleanup();

      setMessages((prev) => [
        ...prev,
        { role: "user_answer", content: answer },
      ]);
      setPhase("evaluating");

      const source = submitAgentAnswer({ sessionId, answer });
      attachListeners(source);
    },
    [sessionId, cleanup, attachListeners],
  );

  const skip = useCallback(() => {
    if (!sessionId) return;
    cleanup();
    setPhase("generating_question");

    const source = skipAgentQuestion(sessionId);
    attachListeners(source);
  }, [sessionId, cleanup, attachListeners]);

  const endEarly = useCallback(async () => {
    if (!sessionId) return;
    cleanup();
    try {
      await endAgentInterview(sessionId);
    } catch {
      setError("면접 종료 처리에 실패했습니다. 리포트가 완성되지 않았을 수 있습니다.");
    } finally {
      setPhase("completed");
    }
  }, [sessionId, cleanup]);

  const lastInnerThought = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "agent_evaluation") {
        const t = (m.evaluation as { innerThought?: string } | undefined)?.innerThought;
        return typeof t === "string" && t.trim() ? t : null;
      }
      if (m.role === "agent_question" || m.role === "agent_followup") {
        // 새 질문이 도착했으면 이전 속마음은 더 이상 표시 안 함
        return null;
      }
    }
    return null;
  })();

  return {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions,
    report,
    error,
    lastInnerThought,
    start,
    submitAnswer,
    skip,
    endEarly,
  };
}
