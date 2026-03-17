'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

interface TextToSpeechHook {
  isSpeaking: boolean;
  isSupported: boolean;
  speak: (text: string) => Promise<void>;
  stop: () => void;
}

export function useTextToSpeech(): TextToSpeechHook {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rejectRef = useRef<((reason?: unknown) => void) | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    // Promise를 reject해서 speak()이 stuck되지 않게
    if (rejectRef.current) {
      rejectRef.current(new DOMException('Stopped', 'AbortError'));
      rejectRef.current = null;
    }

    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.onplay = null;
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string): Promise<void> => {
      stop();

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: abortController.signal,
        });

        if (!res.ok) throw new Error('TTS request failed');

        // abort 체크 — fetch 완료 후 stop이 호출됐을 수 있음
        if (abortController.signal.aborted) return;

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        if (abortController.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }

        await new Promise<void>((resolve, reject) => {
          rejectRef.current = reject;
          const audio = new Audio(url);
          audioRef.current = audio;

          audio.onplay = () => setIsSpeaking(true);
          audio.onended = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(url);
            audioRef.current = null;
            rejectRef.current = null;
            resolve();
          };
          audio.onerror = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(url);
            audioRef.current = null;
            rejectRef.current = null;
            reject(new Error('Audio playback failed'));
          };

          audio.play().catch((err) => {
            rejectRef.current = null;
            reject(err);
          });
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setIsSpeaking(false);
        throw error;
      }
    },
    [stop]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
    };
  }, []);

  return { isSpeaking, isSupported: true, speak, stop };
}
