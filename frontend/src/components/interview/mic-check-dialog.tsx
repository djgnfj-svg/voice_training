'use client';

import { useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMicrophoneCheck } from '@/hooks/useMicrophoneCheck';
import { Loader2, Mic, MicOff, AlertCircle, Keyboard } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MicCheckDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onTextMode?: () => void;
  loading: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  loadingLabel?: string;
}

export function MicCheckDialog({
  open, onOpenChange, onConfirm, onTextMode, loading,
  title = '마이크 확인',
  description = '면접을 시작하기 전에 마이크가 정상 동작하는지 확인합니다.',
  confirmLabel = '면접 시작',
  loadingLabel = 'AI가 면접을 설계하고 있습니다...',
}: MicCheckDialogProps) {
  const {
    status,
    level,
    devices,
    selectedDeviceId,
    errorMessage,
    hasDetectedSound,
    requestMic,
    changeDevice,
    cleanup,
  } = useMicrophoneCheck();

  useEffect(() => {
    if (open && status === 'idle') {
      requestMic();
    }
    if (!open) {
      cleanup();
    }
  }, [open, status, requestMic, cleanup]);

  const canStart = status === 'active' && hasDetectedSound && !loading;

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      cleanup();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mic className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Requesting permission */}
          {status === 'requesting' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">마이크 권한을 요청하고 있습니다...</p>
            </div>
          )}

          {/* Permission denied */}
          {status === 'denied' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
                <MicOff className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
                <div>
                  <p className="font-medium text-red-800 dark:text-red-200">마이크 권한 거부됨</p>
                  <p className="mt-1 text-sm text-red-700 dark:text-red-300">{errorMessage}</p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={requestMic}>
                다시 시도
              </Button>
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div>
                  <p className="font-medium text-amber-800 dark:text-amber-200">마이크 오류</p>
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{errorMessage}</p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={requestMic}>
                다시 시도
              </Button>
            </div>
          )}

          {/* Active — level meter + device selector */}
          {status === 'active' && (
            <>
              {/* Level meter */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">오디오 레벨</span>
                  {hasDetectedSound ? (
                    <span className="text-green-600 dark:text-green-400">소리 감지됨</span>
                  ) : (
                    <span className="text-muted-foreground">마이크에 말해보세요...</span>
                  )}
                </div>
                <div className="h-4 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-75',
                      level < 30
                        ? 'bg-green-500'
                        : level < 70
                          ? 'bg-yellow-500'
                          : 'bg-red-500'
                    )}
                    style={{ width: `${level}%` }}
                  />
                </div>
              </div>

              {/* Device selector — only when 2+ devices */}
              {devices.length >= 2 && (
                <div className="space-y-1.5">
                  <label className="text-sm text-muted-foreground">입력 장치</label>
                  <Select value={selectedDeviceId ?? ''} onValueChange={changeDevice}>
                    <SelectTrigger>
                      <SelectValue placeholder="장치 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.map((d) => (
                        <SelectItem key={d.deviceId} value={d.deviceId}>
                          {d.label || `마이크 ${d.deviceId.slice(0, 8)}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {!hasDetectedSound && (
                <p className="text-center text-xs text-muted-foreground">
                  마이크가 연결되어 있는지 확인하고, 소리를 내보세요.
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer buttons */}
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => handleClose(false)} disabled={loading}>
              취소
            </Button>
            <Button
              className="flex-1"
              disabled={!canStart}
              onClick={onConfirm}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {loadingLabel}
                </>
              ) : (
                <>
                  <Mic className="mr-2 h-4 w-4" />
                  {confirmLabel}
                </>
              )}
            </Button>
          </div>
          {onTextMode && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onTextMode}
              disabled={loading}
            >
              <Keyboard className="mr-2 h-4 w-4" />
              마이크 없이 텍스트로 답변하기
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
