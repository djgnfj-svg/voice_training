// frontend/src/hooks/useJournalSession.ts
import { useCallback, useRef, useState } from "react";
import {
  startJournalSession,
  sendJournalMessage,
  endJournalSession,
  type JournalMessageData,
  type JournalEndResponse,
  type JournalStartResponse,
} from "@/lib/journal-api";

export type JournalPhase =
  | "idle"
  | "starting"
  | "choose"       // 이전 세션 발견 → 이어하기/새로 시작 선택
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
  const [resumed, setResumed] = useState(false);

  // 이전 세션 정보 (choose 화면에서 사용)
  const pendingSessionRef = useRef<JournalStartResponse | null>(null);

  const sourceRef = useRef<ReturnType<typeof sendJournalMessage> | null>(null);

  const cleanup = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  // API 호출 → 이전 세션 있으면 choose, 없으면 바로 active
  const start = useCallback(async () => {
    setPhase("starting");
    setError(null);
    setSummary(null);
    setResumed(false);

    try {
      const data = await startJournalSession();

      if (data.resumed && data.messages.length > 0) {
        // 이전 세션 발견 → 선택 화면
        pendingSessionRef.current = data;
        setPhase("choose");
      } else {
        // 신규 세션 → 바로 시작
        setSessionId(data.sessionId);
        setMessageCount(0);
        setFreeMessagesUsed(0);
        setMessages([]);
        setMode("journal");
        setResumed(false);
        setPhase("active");
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }, []);

  // 이전 세션 이어하기
  const resumeSession = useCallback(() => {
    const data = pendingSessionRef.current;
    if (!data) return;

    setSessionId(data.sessionId);
    setMessageCount(data.messageCount);
    setFreeMessagesUsed(data.freeMessagesUsed);
    setMessages(
      data.messages.map((m: JournalMessageData) => ({
        role: m.role,
        content: m.content,
        mode: m.mode,
      })),
    );
    const lastMode = data.messages[data.messages.length - 1]?.mode || "journal";
    setMode(lastMode);
    setResumed(true);
    pendingSessionRef.current = null;
    setPhase("active");
  }, []);

  // 이전 세션 닫고 새로 시작
  const startFresh = useCallback(async () => {
    const data = pendingSessionRef.current;
    if (!data) return;

    setPhase("starting");
    pendingSessionRef.current = null;

    try {
      // 이전 세션 종료
      await endJournalSession(data.sessionId);
      // 새 세션 시작
      const newData = await startJournalSession();
      setSessionId(newData.sessionId);
      setMessageCount(0);
      setFreeMessagesUsed(0);
      setMessages([]);
      setMode("journal");
      setResumed(false);
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
    resumed,
    start,
    resumeSession,
    startFresh,
    sendMessage,
    end,
  };
}
