// frontend/src/hooks/useJournalSession.ts
import { useCallback, useRef, useState } from "react";
import {
  startJournalSession,
  sendJournalMessage,
  endJournalSession,
  type JournalMessageData,
  type JournalEndResponse,
} from "@/lib/journal-api";

export type JournalPhase =
  | "idle"       // 랜딩 화면 (시작 버튼 대기)
  | "starting"   // 세션 생성 중
  | "active"
  | "responding"
  | "summarizing"
  | "completed"
  | "error";

export interface JournalMessage {
  role: "user" | "assistant";
  content: string;
  mode: "journal" | "counseling";
}

export function useJournalSession() {
  const [phase, setPhase] = useState<JournalPhase>("idle");
  const [messages, setMessages] = useState<JournalMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<"journal" | "counseling">("journal");
  const [messageCount, setMessageCount] = useState(0);
  const [freeMessagesUsed, setFreeMessagesUsed] = useState(0);
  const [summary, setSummary] = useState<JournalEndResponse["summary"]>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<ReturnType<typeof sendJournalMessage> | null>(null);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  // 시작하기 → 기존 세션 있으면 자동 종료 후 새 세션 생성
  const begin = useCallback(async () => {
    setPhase("starting");
    setError(null);
    setSummary(null);

    try {
      const data = await startJournalSession();

      if (data.resumed && data.messages.length > 0) {
        // 기존 세션 자동 종료 후 새 세션 시작
        await endJournalSession(data.sessionId);
        const newData = await startJournalSession();
        setSessionId(newData.sessionId);
      } else {
        setSessionId(data.sessionId);
      }

      setMessageCount(0);
      setFreeMessagesUsed(0);
      setMessages([]);
      setMode("journal");
      setPhase("active");
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }, []);

  const sendMessage = useCallback(
    (message: string) => {
      if (!sessionId) return;
      cleanup();

      setMessages((prev) => [
        ...prev,
        { role: "user", content: message, mode },
      ]);
      setPhase("responding");

      const source = sendJournalMessage(sessionId, message);
      sourceRef.current = source;

      source.addEventListener("response", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.content, mode: data.mode },
        ]);
        setMode(data.mode);
        setMessageCount((prev) => prev + 1);
        setPhase("active");
      });

      source.addEventListener("status", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        if (data.phase === "mode_change") {
          setMode(data.mode);
        }
      });

      source.addEventListener("error", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.code === "INSUFFICIENT_CREDITS") {
            setError("크레딧이 부족합니다");
          } else {
            setError(data.error || "오류가 발생했습니다");
          }
        } catch {
          setError("연결이 끊어졌습니다");
        }
        setPhase("error");
        cleanup();
      });
    },
    [sessionId, mode, cleanup],
  );

  const end = useCallback(async () => {
    if (!sessionId) return;
    cleanup();
    setPhase("summarizing");

    try {
      const data = await endJournalSession(sessionId);
      setSummary(data.summary);
      setPhase("completed");
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }, [sessionId, cleanup]);

  return {
    phase,
    messages,
    sessionId,
    mode,
    messageCount,
    freeMessagesUsed,
    summary,
    error,
    begin,
    sendMessage,
    end,
  };
}
