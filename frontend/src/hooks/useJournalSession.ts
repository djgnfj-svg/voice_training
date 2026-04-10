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
  | "idle"
  | "starting"
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

  const start = useCallback(async () => {
    setPhase("starting");
    setError(null);

    try {
      const data = await startJournalSession();
      setSessionId(data.sessionId);
      setMessageCount(data.messageCount);
      setFreeMessagesUsed(data.freeMessagesUsed);

      if (data.resumed && data.messages.length > 0) {
        setMessages(
          data.messages.map((m: JournalMessageData) => ({
            role: m.role,
            content: m.content,
            mode: m.mode,
          })),
        );
        const lastMode = data.messages[data.messages.length - 1]?.mode || "journal";
        setMode(lastMode);
      } else {
        setMessages([]);
        setMode("journal");
      }

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
    start,
    sendMessage,
    end,
  };
}
