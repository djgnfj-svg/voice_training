// frontend/src/lib/agent-interview-api.ts

export interface AgentStartParams {
  resumeId: string;
  jobPostingId?: string;
  maxQuestions?: number;
  textMode?: boolean;
}

export interface AgentAnswerParams {
  sessionId: string;
  answer: string;
}

export async function endAgentInterview(sessionId: string) {
  const res = await fetch(`/api/agent-interview/${sessionId}/end`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error("면접 종료에 실패했습니다");
  return res.json();
}

export async function getAgentSession(sessionId: string) {
  const res = await fetch(`/api/agent-interview/${sessionId}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("세션을 불러올 수 없습니다");
  return res.json();
}

// Helper: POST-based SSE using fetch + ReadableStream
// Returns an object with addEventListener/close, similar to EventSource
export function createSSEFromPost(url: string, body: object) {
  const controller = new AbortController();
  const listeners: Record<string, ((e: MessageEvent) => void)[]> = {};

  const source = {
    close() {
      controller.abort();
    },
    addEventListener(type: string, handler: (e: MessageEvent) => void) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type: string, handler: (e: MessageEvent) => void) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((h) => h !== handler);
      }
    },
  };

  (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        credentials: "include",
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: "요청 실패" }));
        for (const handler of listeners["error"] || []) {
          handler(new MessageEvent("error", { data: JSON.stringify(data) }));
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "message";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            for (const handler of listeners[currentEvent] || []) {
              handler(new MessageEvent(currentEvent, { data }));
            }
            currentEvent = "message";
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        for (const handler of listeners["error"] || []) {
          handler(new MessageEvent("error", { data: JSON.stringify({ error: "연결 실패" }) }));
        }
      }
    }
  })();

  return source;
}

export function startAgentInterview(params: AgentStartParams) {
  return createSSEFromPost("/api/agent-interview/start", params);
}

export function submitAgentAnswer(params: AgentAnswerParams) {
  return createSSEFromPost(`/api/agent-interview/${params.sessionId}/answer`, {
    answer: params.answer,
  });
}

export function skipAgentQuestion(sessionId: string) {
  return createSSEFromPost(`/api/agent-interview/${sessionId}/skip`, {});
}
