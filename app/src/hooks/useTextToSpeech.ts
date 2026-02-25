'use client';

import { useState, useCallback, useRef } from 'react';

interface TextToSpeechHook {
  isSpeaking: boolean;
  isSupported: boolean;
  speak: (text: string) => Promise<void>;
  stop: () => void;
}

export function useTextToSpeech(): TextToSpeechHook {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const isSupported =
    typeof window !== 'undefined' && 'speechSynthesis' in window;

  const speak = useCallback(
    (text: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        if (!isSupported) {
          reject(new Error('Speech synthesis not supported'));
          return;
        }

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ko-KR';
        utterance.rate = 0.95;
        utterance.pitch = 1;
        utterance.volume = 1;

        // Try to find a Korean voice
        const voices = window.speechSynthesis.getVoices();
        const koreanVoice = voices.find(
          (v) => v.lang === 'ko-KR' || v.lang.startsWith('ko')
        );
        if (koreanVoice) {
          utterance.voice = koreanVoice;
        }

        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => {
          setIsSpeaking(false);
          resolve();
        };
        utterance.onerror = (event) => {
          setIsSpeaking(false);
          if (event.error !== 'canceled') {
            reject(new Error(`Speech synthesis error: ${event.error}`));
          } else {
            resolve();
          }
        };

        utteranceRef.current = utterance;
        window.speechSynthesis.speak(utterance);
      });
    },
    [isSupported]
  );

  const stop = useCallback(() => {
    if (isSupported) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, [isSupported]);

  return { isSpeaking, isSupported, speak, stop };
}
