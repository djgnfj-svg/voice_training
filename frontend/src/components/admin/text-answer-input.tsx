'use client';
import { useState, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Send } from 'lucide-react';

interface Props {
  onSubmit: (text: string) => void;
  onSkip?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function TextAnswerInput({ onSubmit, onSkip, disabled, placeholder }: Props) {
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="space-y-3" data-testid="admin-text-answer">
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        Admin 텍스트 모드 (음성 비활성)
      </div>
      <textarea
        data-testid="admin-text-answer-textarea"
        className="w-full min-h-[120px] rounded-md border bg-background p-3 text-sm"
        value={value}
        placeholder={placeholder ?? '답변을 입력하세요 (Ctrl/Cmd+Enter 제출)'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled}
      />
      <div className="flex justify-end gap-2">
        {onSkip && (
          <Button variant="outline" onClick={onSkip} disabled={disabled} data-testid="admin-text-skip">
            건너뛰기
          </Button>
        )}
        <Button onClick={handleSubmit} disabled={disabled || !value.trim()} data-testid="admin-text-submit">
          <Send className="mr-2 h-4 w-4" /> 제출
        </Button>
      </div>
    </div>
  );
}
