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
  | "error";

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
      });

      source.addEventListener("session", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setSessionId(data.sessionId);
        setQuestionCount(data.questionCount);
        setMaxQuestions(data.maxQuestions);
      });

      source.addEventListener("question", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          {
            role: data.followUpRound > 0 ? "agent_followup" : "agent_question",
            content: data.question,
            questionNumber: data.questionNumber,
            followUpRound: data.followUpRound,
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
        if (data.action === "end") {
          // Report will come via "complete" event
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
    await endAgentInterview(sessionId);
    setPhase("completed");
  }, [sessionId, cleanup]);

  return {
    phase,
    messages,
    sessionId,
    questionCount,
    maxQuestions,
    report,
    error,
    start,
    submitAnswer,
    skip,
    endEarly,
  };
}
