'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

export interface AudioRecorderHook {
  isRecording: boolean;
  isSupported: boolean;
  startRecording: () => void;
  stopRecording: () => Promise<Blob | null>;
  resetRecording: () => void;
}

export function useAudioRecorder(): AudioRecorderHook {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const isSupported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  const startRecording = useCallback(async () => {
    if (!isSupported) return;

    try {
      // Reuse existing stream if available, otherwise request new one
      if (!streamRef.current || streamRef.current.getTracks().some(t => t.readyState === 'ended')) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      chunksRef.current = [];
      blobRef.current = null;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(streamRef.current, { mimeType });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000); // collect in 1s chunks
      setIsRecording(true);
    } catch (error) {
      console.warn('Audio recording failed to start:', error);
    }
  }, [isSupported]);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      setIsRecording(false);
      return Promise.resolve(null);
    }

    const recorder = mediaRecorderRef.current;

    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        if (chunksRef.current.length > 0) {
          blobRef.current = new Blob(chunksRef.current, { type: recorder.mimeType });
        }
        resolve(blobRef.current);
      };

      recorder.stop();
      setIsRecording(false);
    });
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  const resetRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    chunksRef.current = [];
    blobRef.current = null;
    mediaRecorderRef.current = null;
    releaseStream();
    setIsRecording(false);
  }, [releaseStream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return {
    isRecording,
    isSupported,
    startRecording,
    stopRecording,
    resetRecording,
  };
}
