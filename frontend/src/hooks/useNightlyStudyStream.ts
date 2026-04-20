import { useCallback, useEffect, useRef, useState } from 'react';

export interface TurnMeta {
  mode: string;
  intent: string;
  nodeChangedTo: { id: string; title: string } | null;
  proficiencyAfter: number | null;
  shouldSuggestEnd: boolean;
  awaitingGoalConfirm: { proposedGoal: string } | null;
  goalChangedTo: { id: string; title: string } | null;
}

export type StreamPhase = 'thinking' | 'retrieving' | 'generating';

export interface PhaseEvent {
  phase: StreamPhase;
  label: string;
}

export interface UseNightlyStudyStreamOptions {
  sessionId: string;
  onText: (text: string) => void;
  onMeta: (meta: TurnMeta) => void;
  onPhase: (phase: PhaseEvent) => void;
  onError: (msg: string) => void;
  onEnd: (turnCount: number) => void;
}

export function useNightlyStudyStream(opts: UseNightlyStudyStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Store callbacks in refs so sendTurn doesn't need them in its dep array
  const onTextRef = useRef(opts.onText);
  const onMetaRef = useRef(opts.onMeta);
  const onPhaseRef = useRef(opts.onPhase);
  const onErrorRef = useRef(opts.onError);
  const onEndRef = useRef(opts.onEnd);
  useEffect(() => {
    onTextRef.current = opts.onText;
    onMetaRef.current = opts.onMeta;
    onPhaseRef.current = opts.onPhase;
    onErrorRef.current = opts.onError;
    onEndRef.current = opts.onEnd;
  });

  const sendTurn = useCallback(async (userUtterance: string) => {
    if (isStreaming) return;
    setIsStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`/api/nightly-study/${opts.sessionId}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ userUtterance }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        onErrorRef.current('연결에 실패했어요');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // sse-starlette는 이벤트 구분자로 \r\n\r\n을 쓰기도 한다. CRLF를 LF로 정규화.
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = chunk.split('\n');
          let event = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload: unknown;
          try { payload = JSON.parse(data); } catch { continue; }

          if (event === 'text') {
            onTextRef.current(typeof payload === 'string' ? payload : (payload as { text?: string }).text || String(payload));
          } else if (event === 'meta') {
            onMetaRef.current(payload as TurnMeta);
          } else if (event === 'phase') {
            onPhaseRef.current(payload as PhaseEvent);
          } else if (event === 'error') {
            onErrorRef.current((payload as { error?: string })?.error || '에러');
          } else if (event === 'end') {
            onEndRef.current((payload as { turnCount?: number })?.turnCount ?? 0);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        onErrorRef.current('연결이 끊겼어요');
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming, opts.sessionId]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { isStreaming, sendTurn, abort };
}
