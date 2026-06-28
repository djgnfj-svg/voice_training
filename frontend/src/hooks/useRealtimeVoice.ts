'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type RealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'closed'
  | 'error'
  | 'unsupported';

export interface RealtimeMeta {
  tool: string;
  result: Record<string, unknown>;
}

export interface RealtimeTranscript {
  role: 'user' | 'assistant';
  text: string;
}

export interface RealtimeGuard {
  reason: 'session_cap' | 'idle' | 'daily_cap';
  message: string;
}

export interface UseRealtimeVoiceOptions {
  sessionId: string;
  onMeta?: (meta: RealtimeMeta) => void;
  onTranscript?: (t: RealtimeTranscript) => void;
  onGuard?: (g: RealtimeGuard) => void;
  /** Called when realtime is unavailable / failed so the caller can fall back. */
  onUnavailable?: (reason: string) => void;
}

const PLAYBACK_RATE = 24000; // OpenAI Realtime pcm16 output rate

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(len / 2));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

export function useRealtimeVoice(opts: UseRealtimeVoiceOptions) {
  const { sessionId } = opts;
  const [status, setStatus] = useState<RealtimeStatus>('idle');

  // Callback refs (stable identity for effect/socket handlers).
  const onMetaRef = useRef(opts.onMeta);
  const onTranscriptRef = useRef(opts.onTranscript);
  const onGuardRef = useRef(opts.onGuard);
  const onUnavailableRef = useRef(opts.onUnavailable);
  useEffect(() => {
    onMetaRef.current = opts.onMeta;
    onTranscriptRef.current = opts.onTranscript;
    onGuardRef.current = opts.onGuard;
    onUnavailableRef.current = opts.onUnavailable;
  });

  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Playback
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playheadRef = useRef(0);
  const playingSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const stoppedRef = useRef(false);

  const stopPlayback = useCallback(() => {
    // Barge-in: stop everything currently scheduled.
    for (const src of playingSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    playingSourcesRef.current.clear();
    playheadRef.current = playbackCtxRef.current?.currentTime ?? 0;
  }, []);

  const enqueueAudio = useCallback((int16: Int16Array) => {
    const ctx = playbackCtxRef.current;
    if (!ctx || int16.length === 0) return;
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 0x8000;
    const buffer = ctx.createBuffer(1, float.length, PLAYBACK_RATE);
    buffer.copyToChannel(float, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, playheadRef.current);
    src.start(startAt);
    playheadRef.current = startAt + buffer.duration;
    playingSourcesRef.current.add(src);
    src.onended = () => {
      playingSourcesRef.current.delete(src);
    };
  }, []);

  const cleanup = useCallback(() => {
    stoppedRef.current = true;
    try {
      workletNodeRef.current?.disconnect();
    } catch {
      // ignore
    }
    workletNodeRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    void captureCtxRef.current?.close().catch(() => {});
    captureCtxRef.current = null;
    stopPlayback();
    void playbackCtxRef.current?.close().catch(() => {});
    playbackCtxRef.current = null;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'bye' }));
      } catch {
        // ignore
      }
    }
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
  }, [stopPlayback]);

  const hangup = useCallback(() => {
    cleanup();
    setStatus('closed');
  }, [cleanup]);

  const start = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (
      !AudioCtx ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof WebSocket === 'undefined'
    ) {
      setStatus('unsupported');
      onUnavailableRef.current?.('이 브라우저에서는 실시간 음성을 지원하지 않아요.');
      return;
    }

    stoppedRef.current = false;
    setStatus('connecting');

    // 1) Mic capture + AudioWorklet (PCM16 24kHz).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const captureCtx = new AudioCtx();
      captureCtxRef.current = captureCtx;
      await captureCtx.audioWorklet.addModule('/pcm16-worklet.js');
      const source = captureCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(captureCtx, 'pcm16-downsampler');
      workletNodeRef.current = worklet;
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            type: 'input_audio',
            audio: arrayBufferToBase64(e.data),
          }),
        );
      };
      source.connect(worklet);
      // Worklet must be in the graph to pull audio; route to a muted gain.
      const sink = captureCtx.createGain();
      sink.gain.value = 0;
      worklet.connect(sink).connect(captureCtx.destination);
    } catch (err) {
      cleanup();
      setStatus('error');
      const msg =
        (err as Error)?.name === 'NotAllowedError'
          ? '마이크 권한이 필요해요.'
          : '마이크를 시작하지 못했어요.';
      onUnavailableRef.current?.(msg);
      return;
    }

    // 2) Playback context.
    playbackCtxRef.current = new AudioCtx();
    playheadRef.current = playbackCtxRef.current.currentTime;

    // 3) WebSocket relay.
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/api/learning-coach/${sessionId}/realtime`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready':
          setStatus('live');
          break;
        case 'output_audio':
          if (typeof msg.audio === 'string') enqueueAudio(base64ToInt16(msg.audio));
          break;
        case 'speech_started':
          // Barge-in — user started talking, cut local playback immediately.
          stopPlayback();
          break;
        case 'transcript':
          onTranscriptRef.current?.({
            role: msg.role === 'user' ? 'user' : 'assistant',
            text: String(msg.text ?? ''),
          });
          break;
        case 'meta':
          onMetaRef.current?.({
            tool: String(msg.tool ?? ''),
            result: (msg.result as Record<string, unknown>) ?? {},
          });
          break;
        case 'guard':
          onGuardRef.current?.({
            reason: (msg.reason as RealtimeGuard['reason']) ?? 'idle',
            message: String(msg.message ?? ''),
          });
          break;
        case 'error':
          onUnavailableRef.current?.(String(msg.message ?? '음성 연결에 문제가 생겼어요.'));
          break;
        case 'closed':
          break;
      }
    };

    ws.onerror = () => {
      if (stoppedRef.current) return;
      onUnavailableRef.current?.('음성 연결에 실패했어요.');
    };

    ws.onclose = (ev) => {
      if (stoppedRef.current) return;
      // Application close codes signal why the relay refused (fallback hints).
      if (ev.code === 4401) onUnavailableRef.current?.('로그인이 필요해요.');
      else if (ev.code === 4403) onUnavailableRef.current?.('실시간 음성이 꺼져 있어요.');
      else if (ev.code === 4404) onUnavailableRef.current?.('세션을 찾을 수 없어요.');
      else if (ev.code === 4429) onUnavailableRef.current?.('오늘 음성 사용 시간을 모두 썼어요.');
      cleanup();
      setStatus('closed');
    };
  }, [sessionId, cleanup, enqueueAudio, stopPlayback]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return { status, start, hangup };
}
