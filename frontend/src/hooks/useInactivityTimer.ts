// frontend/src/hooks/useInactivityTimer.ts
import { useCallback, useEffect, useRef, useState } from "react";

interface UseInactivityTimerOptions {
  timeoutMs: number;
  warningMs: number;
  onWarning: () => void;
  onTimeout: () => void;
  enabled: boolean;
}

export function useInactivityTimer({
  timeoutMs = 120000,
  warningMs = 10000,
  onWarning,
  onTimeout,
  enabled,
}: UseInactivityTimerOptions) {
  const [isWarning, setIsWarning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    setIsWarning(false);
  }, []);

  const resetTimer = useCallback(() => {
    clearTimers();

    if (!enabled) return;

    timerRef.current = setTimeout(() => {
      setIsWarning(true);
      onWarning();

      warningTimerRef.current = setTimeout(() => {
        onTimeout();
      }, warningMs);
    }, timeoutMs);
  }, [enabled, timeoutMs, warningMs, onWarning, onTimeout, clearTimers]);

  const dismiss = useCallback(() => {
    clearTimers();
    resetTimer();
  }, [clearTimers, resetTimer]);

  useEffect(() => {
    if (enabled) {
      resetTimer();
    } else {
      clearTimers();
    }
    return clearTimers;
  }, [enabled, resetTimer, clearTimers]);

  return { isWarning, resetTimer, dismiss };
}
