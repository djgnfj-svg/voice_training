'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

export type TTSPersona =
  | 'default'
  | 'interviewer'
  | 'tutor';

export interface TTSSpeakOptions {
  persona?: TTSPersona;
}

interface TextToSpeechHook {
  isSpeaking: boolean;
  isSupported: boolean;
  volume: number;
  setVolume: (v: number) => void;
  speak: (text: string, options?: TTSSpeakOptions) => Promise<void>;
  stop: () => void;
}

export interface UseTextToSpeechOptions {
  persona?: TTSPersona;
}

export function useTextToSpeech(options: UseTextToSpeechOptions = {}): TextToSpeechHook {
  const defaultPersona = options.persona;
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const volumeRef = useRef(0.7);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rejectRef = useRef<((reason?: unknown) => void) | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const handleSetVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolume(clamped);
    volumeRef.current = clamped;
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.onplay = null;
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (rejectRef.current) {
      rejectRef.current(new DOMException('Stopped', 'AbortError'));
      rejectRef.current = null;
    }
    cleanup();
    setIsSpeaking(false);
  }, [cleanup]);

  const playBuffered = useCallback(
    async (res: Response, signal: AbortSignal): Promise<void> => {
      const blob = await res.blob();
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(url);
        audio.volume = volumeRef.current;
        audioRef.current = audio;

        let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        const settle = (err?: unknown) => {
          if (settled) return;
          settled = true;
          if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
          }
          setIsSpeaking(false);
          rejectRef.current = null;
          if (err) reject(err);
          else resolve();
        };

        rejectRef.current = (reason) => settle(reason ?? new DOMException('Stopped', 'AbortError'));

        const scheduleFallback = () => {
          if (fallbackTimer) clearTimeout(fallbackTimer);
          const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 30;
          const remaining = Math.max(1, d - audio.currentTime);
          fallbackTimer = setTimeout(() => settle(), (remaining + 2) * 1000);
        };

        audio.onloadedmetadata = scheduleFallback;
        audio.onplay = () => {
          setIsSpeaking(true);
          scheduleFallback();
        };
        audio.onended = () => settle();
        audio.onerror = () => settle(new Error('Audio playback failed'));

        audio.play().catch((err) => settle(err));

        // 메타데이터 로드 없이도 안전장치 — 최장 60초 후 강제 완료
        fallbackTimer = setTimeout(() => settle(), 60_000);
      });
    },
    []
  );

  const speak = useCallback(
    async (text: string, speakOptions: TTSSpeakOptions = {}): Promise<void> => {
      stop();

      const abortController = new AbortController();
      abortRef.current = abortController;

      const persona = speakOptions.persona ?? defaultPersona;
      const payload: Record<string, unknown> = { text };
      if (persona) payload.persona = persona;

      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: abortController.signal,
        });

        if (!res.ok) throw new Error('TTS request failed');
        if (abortController.signal.aborted) return;

        await playBuffered(res, abortController.signal);
        cleanup();
      } catch (error) {
        cleanup();
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setIsSpeaking(false);
        throw error;
      }
    },
    [stop, cleanup, playBuffered, defaultPersona]
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cleanup();
    };
  }, [cleanup]);

  return { isSpeaking, isSupported: true, volume, setVolume: handleSetVolume, speak, stop };
}
