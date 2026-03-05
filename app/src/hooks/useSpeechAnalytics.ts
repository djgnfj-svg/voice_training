'use client';

import { useState, useRef, useCallback } from 'react';
import { countFillerWords } from '@/lib/transcript';

export interface SpeechMetrics {
  wpm: number;
  fillerCount: number;
  silenceSec: number;
  silenceRatio: number;
  elapsedSec: number;
}

const SILENCE_THRESHOLD_MS = 2000;
const TICK_INTERVAL_MS = 500;

const INITIAL_METRICS: SpeechMetrics = {
  wpm: 0,
  fillerCount: 0,
  silenceSec: 0,
  silenceRatio: 0,
  elapsedSec: 0,
};

export function useSpeechAnalytics() {
  const [metrics, setMetrics] = useState<SpeechMetrics>(INITIAL_METRICS);

  const startTimeRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTranscriptRef = useRef<string>('');
  const lastChangeTimeRef = useRef<number>(0);
  const silenceAccRef = useRef<number>(0);

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const update = useCallback((rawTranscript: string) => {
    const now = Date.now();
    const elapsedMs = now - startTimeRef.current;
    const elapsedSec = Math.max(elapsedMs / 1000, 0.1);

    // Detect transcript changes for silence tracking
    if (rawTranscript !== lastTranscriptRef.current) {
      lastTranscriptRef.current = rawTranscript;
      lastChangeTimeRef.current = now;
    }

    // Accumulate silence: if no change for > threshold, add tick duration
    const silentDuration = now - lastChangeTimeRef.current;
    if (silentDuration >= SILENCE_THRESHOLD_MS) {
      silenceAccRef.current += TICK_INTERVAL_MS / 1000;
    }

    const silenceSec = Math.round(silenceAccRef.current * 10) / 10;
    const silenceRatio = elapsedSec > 0 ? Math.min(silenceSec / elapsedSec, 1) : 0;

    // Korean syllable count ~ character count (excluding spaces/punctuation)
    const charCount = rawTranscript.replace(/[\s.,!?;:'"()\-]/g, '').length;
    const minutes = elapsedSec / 60;
    const wpm = minutes > 0 ? Math.round(charCount / minutes) : 0;

    const fillerCount = countFillerWords(rawTranscript);

    setMetrics({
      wpm,
      fillerCount,
      silenceSec,
      silenceRatio: Math.round(silenceRatio * 100) / 100,
      elapsedSec: Math.round(elapsedSec),
    });
  }, []);

  const start = useCallback((rawTranscript: string) => {
    cleanup();
    const now = Date.now();
    startTimeRef.current = now;
    lastTranscriptRef.current = rawTranscript;
    lastChangeTimeRef.current = now;
    silenceAccRef.current = 0;
    setMetrics(INITIAL_METRICS);

    intervalRef.current = setInterval(() => {
      update(lastTranscriptRef.current);
    }, TICK_INTERVAL_MS);
  }, [cleanup, update]);

  const feed = useCallback((rawTranscript: string) => {
    if (rawTranscript !== lastTranscriptRef.current) {
      lastTranscriptRef.current = rawTranscript;
      lastChangeTimeRef.current = Date.now();
    }
    update(rawTranscript);
  }, [update]);

  const stop = useCallback((): SpeechMetrics => {
    cleanup();
    // Final update
    update(lastTranscriptRef.current);
    return { ...metrics, elapsedSec: Math.round((Date.now() - startTimeRef.current) / 1000) };
  }, [cleanup, update, metrics]);

  const reset = useCallback(() => {
    cleanup();
    startTimeRef.current = 0;
    lastTranscriptRef.current = '';
    lastChangeTimeRef.current = 0;
    silenceAccRef.current = 0;
    setMetrics(INITIAL_METRICS);
  }, [cleanup]);

  return { metrics, start, feed, stop, reset };
}
