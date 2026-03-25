'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Mic, FileText, ArrowRight } from 'lucide-react';

interface WelcomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const steps = [
  {
    icon: Mic,
    title: '보이스프렙에 오신 것을 환영합니다!',
    description: '타이핑 대신 실제 면접처럼 음성으로 답변하며 연습하세요. AI가 꼬리질문으로 깊이를 파고들고, 실시간 피드백으로 성장합니다.',
  },
  {
    icon: FileText,
    title: '이력서를 업로드하세요',
    description: 'PDF 이력서를 업로드하면 AI가 기술스택과 프로젝트를 분석하여 맞춤 면접 질문을 생성합니다.',
  },
  {
    icon: ArrowRight,
    title: '첫 면접을 시작하세요',
    description: '첫 면접은 무료입니다! 이력서를 선택하고 면접을 시작하면 AI가 질문하고, 음성으로 답변하면 됩니다.',
  },
];

export function WelcomeDialog({ open, onOpenChange }: WelcomeDialogProps) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);

  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;

  const handleNext = () => {
    if (isLastStep) {
      onOpenChange(false);
      router.push('/profile');
    } else {
      setStepIndex((prev) => prev + 1);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <currentStep.icon className="h-8 w-8 text-primary" />
          </div>
          <DialogTitle className="text-center text-xl">{currentStep.title}</DialogTitle>
          <DialogDescription className="text-center">
            {currentStep.description}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 py-2">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 w-8 rounded-full transition-colors ${
                i === stepIndex ? 'bg-primary' : 'bg-muted'
              }`}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          {stepIndex > 0 && (
            <Button variant="outline" onClick={() => setStepIndex((prev) => prev - 1)}>
              이전
            </Button>
          )}
          <Button onClick={handleNext}>
            {isLastStep ? '이력서 업로드하기' : '다음'}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
