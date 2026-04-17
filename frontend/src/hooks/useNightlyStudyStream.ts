import { useCallback, useRef, useState } from 'react';

export interface TurnMeta {
  mode: string;
  intent: string;
  nodeChangedTo: { id: string; title: string } | null;
  proficiencyAfter: number | null;
  shouldSuggestEnd: boolean;
}

export interface UseNightlyStudyStreamOptions {
  sessionId: string;
  onText: (text: string) => void;
  onMeta: (meta: TurnMeta) => void;
  onError: (msg: string) => void;
  onEnd: (turnCount: number) => void;
}

export function useNightlyStudyStream(opts: UseNightlyStudyStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
        opts.onError('연결에 실패했어요');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

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
            opts.onText(typeof payload === 'string' ? payload : (payload as { text?: string }).text || String(payload));
          } else if (event === 'meta') {
            opts.onMeta(payload as TurnMeta);
          } else if (event === 'error') {
            opts.onError((payload as { error?: string })?.error || '에러');
          } else if (event === 'end') {
            opts.onEnd((payload as { turnCount?: number })?.turnCount ?? 0);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        opts.onError('연결이 끊겼어요');
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [isStreaming, opts]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { isStreaming, sendTurn, abort };
}
