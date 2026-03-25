'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export type MicStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'error';

interface MicrophoneCheckState {
  status: MicStatus;
  level: number; // 0-100
  devices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  errorMessage: string | null;
  hasDetectedSound: boolean;
}

interface MicrophoneCheckActions {
  requestMic: () => void;
  changeDevice: (deviceId: string) => void;
  cleanup: () => void;
}

export function useMicrophoneCheck(): MicrophoneCheckState & MicrophoneCheckActions {
  const [status, setStatus] = useState<MicStatus>('idle');
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasDetectedSound, setHasDetectedSound] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const stopStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    stopStream();
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
    setLevel(0);
    setStatus('idle');
    setHasDetectedSound(false);
  }, [stopStream]);

  const startAnalyser = useCallback((stream: MediaStream) => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    sourceRef.current = source;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const normalized = Math.min(100, Math.round((avg / 128) * 100));
      setLevel(normalized);
      if (normalized > 5) setHasDetectedSound(true);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const startStream = useCallback(
    async (deviceId?: string) => {
      stopStream();
      try {
        const constraints: MediaStreamConstraints = {
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        startAnalyser(stream);

        // enumerate devices after permission granted
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = allDevices.filter((d) => d.kind === 'audioinput' && d.deviceId);
        setDevices(audioInputs);

        const activeTrack = stream.getAudioTracks()[0];
        const activeDeviceId = activeTrack?.getSettings().deviceId ?? null;
        setSelectedDeviceId(activeDeviceId);

        setStatus('active');
        setErrorMessage(null);
      } catch (err) {
        const e = err as DOMException;
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          setStatus('denied');
          setErrorMessage('마이크 접근이 거부되었습니다. 브라우저 설정에서 마이크 권한을 허용해주세요.');
        } else {
          setStatus('error');
          setErrorMessage(e.message || '마이크를 사용할 수 없습니다.');
        }
      }
    },
    [stopStream, startAnalyser]
  );

  const requestMic = useCallback(() => {
    setStatus('requesting');
    setErrorMessage(null);
    startStream();
  }, [startStream]);

  const changeDevice = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      startStream(deviceId);
    },
    [startStream]
  );

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    status,
    level,
    devices,
    selectedDeviceId,
    errorMessage,
    hasDetectedSound,
    requestMic,
    changeDevice,
    cleanup,
  };
}
