'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

interface TextToSpeechHook {
  isSpeaking: boolean;
  isSupported: boolean;
  volume: number;
  setVolume: (v: number) => void;
  speak: (text: string) => Promise<void>;
  stop: () => void;
}

const MIME = 'audio/mpeg';

function mseSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const MS = window.MediaSource;
  return !!MS && typeof MS.isTypeSupported === 'function' && MS.isTypeSupported(MIME);
}

export function useTextToSpeech(): TextToSpeechHook {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const volumeRef = useRef(0.7);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rejectRef = useRef<((reason?: unknown) => void) | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);

  const handleSetVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolume(clamped);
    volumeRef.current = clamped;
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (mediaSourceRef.current) {
      try {
        if (mediaSourceRef.current.readyState === 'open') {
          mediaSourceRef.current.endOfStream();
        }
      } catch {
        // ignore
      }
      mediaSourceRef.current = null;
    }
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

  const playStreaming = useCallback(
    async (res: Response, signal: AbortSignal): Promise<void> => {
      if (!res.body) throw new Error('No response body');
      const reader = res.body.getReader();

      const mediaSource = new MediaSource();
      mediaSourceRef.current = mediaSource;
      const url = URL.createObjectURL(mediaSource);
      objectUrlRef.current = url;

      const audio = new Audio(url);
      audio.volume = volumeRef.current;
      audioRef.current = audio;

      await new Promise<void>((resolve, reject) => {
        let sourceBuffer: SourceBuffer | null = null;
        const queue: ArrayBuffer[] = [];
        let streamEnded = false;
        let settled = false;

        const settle = (err?: unknown) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        rejectRef.current = (reason) => settle(reason);

        const pump = () => {
          if (!sourceBuffer || sourceBuffer.updating) return;
          if (queue.length > 0) {
            try {
              sourceBuffer.appendBuffer(queue.shift()!);
            } catch (e) {
              settle(e);
            }
            return;
          }
          if (streamEnded && mediaSource.readyState === 'open') {
            try {
              mediaSource.endOfStream();
            } catch {
              // ignore
            }
          }
        };

        const onSourceOpen = async () => {
          try {
            sourceBuffer = mediaSource.addSourceBuffer(MIME);
            sourceBuffer.addEventListener('updateend', pump);
            sourceBuffer.addEventListener('error', () =>
              settle(new Error('SourceBuffer error'))
            );

            // eslint-disable-next-line no-constant-condition
            while (true) {
              if (signal.aborted) {
                settle(new DOMException('Stopped', 'AbortError'));
                return;
              }
              const { value, done } = await reader.read();
              if (done) {
                streamEnded = true;
                pump();
                break;
              }
              if (value && value.byteLength > 0) {
                const copy = value.buffer.slice(
                  value.byteOffset,
                  value.byteOffset + value.byteLength
                );
                queue.push(copy);
                pump();
              }
            }
          } catch (e) {
            settle(e);
          }
        };

        mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true });

        audio.onplay = () => setIsSpeaking(true);
        audio.onended = () => {
          setIsSpeaking(false);
          rejectRef.current = null;
          settle();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          rejectRef.current = null;
          settle(new Error('Audio playback failed'));
        };

        audio.play().catch((err) => {
          rejectRef.current = null;
          settle(err);
        });
      });
    },
    []
  );

  const playBuffered = useCallback(
    async (res: Response, signal: AbortSignal): Promise<void> => {
      const blob = await res.blob();
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      await new Promise<void>((resolve, reject) => {
        rejectRef.current = reject;
        const audio = new Audio(url);
        audio.volume = volumeRef.current;
        audioRef.current = audio;

        audio.onplay = () => setIsSpeaking(true);
        audio.onended = () => {
          setIsSpeaking(false);
          rejectRef.current = null;
          resolve();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          rejectRef.current = null;
          reject(new Error('Audio playback failed'));
        };

        audio.play().catch((err) => {
          rejectRef.current = null;
          reject(err);
        });
      });
    },
    []
  );

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
        if (abortController.signal.aborted) return;

        if (mseSupported()) {
          await playStreaming(res, abortController.signal);
        } else {
          await playBuffered(res, abortController.signal);
        }
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
    [stop, cleanup, playStreaming, playBuffered]
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cleanup();
    };
  }, [cleanup]);

  return { isSpeaking, isSupported: true, volume, setVolume: handleSetVolume, speak, stop };
}
