'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { isSpeechRecognitionSupported } from '@/lib/utils';

interface SpeechRecognitionHook {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  isSupported: boolean;
  startListening: () => void;
  stopListening: () => void;
  resetTranscript: () => void;
}

// Web Speech API type declarations
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  _shouldListen?: boolean;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

// 모바일 Web Speech API가 동일 final result를 여러 번 emit하면 "제일제일제일..." 처럼 누적됨.
// prev 끝과 next 시작이 겹치면 그만큼 skip하고 붙인다. 최대 100자 overlap 검사.
function appendWithOverlap(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;
  const maxOverlap = Math.min(prev.length, next.length, 100);
  for (let k = maxOverlap; k > 0; k--) {
    if (prev.slice(-k) === next.slice(0, k)) {
      return prev + next.slice(k);
    }
  }
  return prev + next;
}

export function useSpeechRecognition(): SpeechRecognitionHook {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const isSupported = isSpeechRecognitionSupported();

  useEffect(() => {
    if (!isSupported) return;

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'ko-KR';
    recognition.maxAlternatives = 3;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = '';
      let interim = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          // confidence 기반 최적 대안 선택
          let bestIdx = 0;
          let bestConf = result[0].confidence;
          for (let j = 1; j < result.length; j++) {
            if (result[j].confidence > bestConf) {
              bestConf = result[j].confidence;
              bestIdx = j;
            }
          }
          finalTranscript += result[bestIdx].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (finalTranscript) {
        setTranscript((prev) => appendWithOverlap(prev, finalTranscript));
      }
      setInterimTranscript(interim);
    };

    recognition.onerror = (event: Event & { error: string }) => {
      if (event.error === 'no-speech') return;
      console.warn('Speech recognition error:', event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      // Auto-restart if still supposed to be listening
      if (recognitionRef.current?._shouldListen) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;
    recognitionRef.current._shouldListen = false;

    return () => {
      recognition.stop();
    };
  }, [isSupported]);

  const startListening = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current._shouldListen = true;
      recognitionRef.current.start();
      setIsListening(true);
    } catch (error) {
      console.warn('Failed to start speech recognition:', error);
    }
  }, []);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;
    recognitionRef.current._shouldListen = false;
    recognitionRef.current.stop();
    setIsListening(false);
    setInterimTranscript('');
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
  }, []);

  return {
    isListening,
    transcript,
    interimTranscript,
    isSupported,
    startListening,
    stopListening,
    resetTranscript,
  };
}
