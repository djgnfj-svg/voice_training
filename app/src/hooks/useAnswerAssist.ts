'use client';

import { useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface ConversationMessage {
  role: 'user' | 'ai';
  content: string;
}

interface AnswerAssistItem {
  id: string;
  sessionId: string;
  questionIndex: number;
  questionText: string;
  conversation: ConversationMessage[];
  finalAnswer: string | null;
  isCompleted: boolean;
}

interface AnswerAssistSessionDetail {
  id: string;
  userId: string;
  resumeId: string;
  createdAt: string;
  resume: { name: string; parsedData: unknown };
  items: AnswerAssistItem[];
}

export function useAnswerAssist(sessionId: string) {
  const queryClient = useQueryClient();
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isCompiling, setIsCompiling] = useState(false);
  const [compilingText, setCompilingText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const { data: session, isLoading } = useQuery<AnswerAssistSessionDetail>({
    queryKey: ['answer-assist', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/answer-assist/sessions/${sessionId}`);
      if (!res.ok) throw new Error('세션 로드 실패');
      return res.json();
    },
  });

  const activeItem = session?.items.find((i) => i.id === activeItemId) ?? null;

  const sendMessage = useCallback(
    async (text: string) => {
      if (!activeItemId || isStreaming) return;

      setIsStreaming(true);
      setStreamingText('');
      abortRef.current = new AbortController();

      // Optimistically add user message
      queryClient.setQueryData<AnswerAssistSessionDetail>(
        ['answer-assist', sessionId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((item) =>
              item.id === activeItemId
                ? {
                    ...item,
                    conversation: [
                      ...item.conversation,
                      { role: 'user' as const, content: text },
                    ],
                  }
                : item
            ),
          };
        }
      );

      try {
        const res = await fetch(
          `/api/answer-assist/sessions/${sessionId}/items/${activeItemId}/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
            signal: abortRef.current.signal,
          }
        );

        if (!res.ok) throw new Error('API 요청 실패');

        const reader = res.body?.getReader();
        if (!reader) throw new Error('스트림 읽기 실패');

        const decoder = new TextDecoder();
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.text) {
                accumulated += parsed.text;
                setStreamingText(accumulated);
              }
            } catch {
              // skip malformed JSON
            }
          }
        }

        // Update cache with AI response
        queryClient.setQueryData<AnswerAssistSessionDetail>(
          ['answer-assist', sessionId],
          (old) => {
            if (!old) return old;
            return {
              ...old,
              items: old.items.map((item) =>
                item.id === activeItemId
                  ? {
                      ...item,
                      conversation: [
                        ...item.conversation,
                        { role: 'ai' as const, content: accumulated },
                      ],
                    }
                  : item
              ),
            };
          }
        );
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') return;
        console.error('Answer assist chat error:', error);
      } finally {
        setIsStreaming(false);
        setStreamingText('');
        abortRef.current = null;
      }
    },
    [activeItemId, isStreaming, sessionId, queryClient]
  );

  const compileAnswer = useCallback(async () => {
    if (!activeItemId || isCompiling) return;

    setIsCompiling(true);
    setCompilingText('');
    abortRef.current = new AbortController();

    try {
      const res = await fetch(
        `/api/answer-assist/sessions/${sessionId}/items/${activeItemId}/compile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortRef.current.signal,
        }
      );

      if (!res.ok) throw new Error('API 요청 실패');

      const reader = res.body?.getReader();
      if (!reader) throw new Error('스트림 읽기 실패');

      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              accumulated += parsed.text;
              setCompilingText(accumulated);
            }
          } catch {
            // skip malformed JSON
          }
        }
      }

      // Update cache with final answer
      queryClient.setQueryData<AnswerAssistSessionDetail>(
        ['answer-assist', sessionId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((item) =>
              item.id === activeItemId
                ? { ...item, finalAnswer: accumulated, isCompleted: true }
                : item
            ),
          };
        }
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('Answer assist compile error:', error);
    } finally {
      setIsCompiling(false);
      setCompilingText('');
      abortRef.current = null;
    }
  }, [activeItemId, isCompiling, sessionId, queryClient]);

  return {
    session,
    isLoading,
    activeItemId,
    activeItem,
    setActiveItemId,
    isStreaming,
    streamingText,
    isCompiling,
    compilingText,
    sendMessage,
    compileAnswer,
  };
}
