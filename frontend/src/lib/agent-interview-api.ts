// frontend/src/lib/agent-interview-api.ts

export interface AgentStartParams {
  resumeId: string;
  jobPostingId?: string;
  textMode?: boolean;
}

export interface AgentAnswerParams {
  sessionId: string;
  answer: string;
}

export async function endAgentInterview(sessionId: string) {
  // /end는 내부적으로 update_profile + generate_report LLM 호출을 수행해 수 초 소요됨.
  // 브라우저 기본 fetch timeout에 걸리지 않도록 30초 AbortSignal.
  const res = await fetch(`/api/agent-interview/${sessionId}/end`, {
    method: "POST",
    credentials: "include",
    signal: AbortSignal.timeout(30000),
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
      // currentEvent must persist across chunk boundaries — SSE frames
      // (event: ...\ndata: ...\n\n) can be split mid-frame by intermediaries
      // (Cloudflare Tunnel 등). Reset only after a blank line terminates a frame.
      let currentEvent = "message";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line === "" || line === "\r") {
            // Blank line = end of frame → reset event name for next frame
            currentEvent = "message";
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            for (const handler of listeners[currentEvent] || []) {
              handler(new MessageEvent(currentEvent, { data }));
            }
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
