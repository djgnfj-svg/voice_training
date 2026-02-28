'use client';

import { useRouter } from 'next/navigation';
import { Coins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface InsufficientCreditsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InsufficientCreditsDialog({ open, onOpenChange }: InsufficientCreditsDialogProps) {
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5 text-amber-500" />
            크레딧이 부족합니다
          </DialogTitle>
          <DialogDescription>
            이 기능을 사용하려면 크레딧이 필요합니다. 크레딧을 충전하고 면접 연습을 계속하세요.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-3 pt-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
          <Button className="flex-1" onClick={() => router.push('/credits')}>
            <Coins className="mr-2 h-4 w-4" />
            크레딧 충전
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
