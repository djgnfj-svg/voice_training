'use client';

import { cn } from '@/lib/utils';

export type InterviewerExpression =
  | 'neutral'
  | 'listening'
  | 'thinking'
  | 'impressed'
  | 'skeptical'
  | 'disappointed';

interface InterviewerStageProps {
  expression: InterviewerExpression;
  innerThought: string | null;
  className?: string;
}

export function InterviewerStage({
  expression,
  innerThought,
  className,
}: InterviewerStageProps) {
  return (
    <div
      data-testid="interviewer-stage"
      className={cn(
        'relative flex aspect-[5/3] w-full items-center overflow-hidden rounded-2xl',
        'bg-gradient-to-br from-slate-200 via-slate-300 to-slate-400',
        'dark:from-slate-700 dark:via-slate-800 dark:to-slate-900',
        className,
      )}
    >
      {/* 좌측 캐릭터 (45%) */}
      <div className="relative h-full w-[45%] flex-shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/interviewer/${expression}.svg`}
          alt={`면접관 표정: ${expression}`}
          className="absolute inset-0 h-full w-full object-contain object-bottom"
          data-testid={`interviewer-expression-${expression}`}
        />
      </div>

      {/* 우측 속마음 영역 (55%) */}
      <div className="flex flex-1 items-center pr-4">
        {innerThought ? (
          <div
            data-testid="inner-thought-bubble"
            className={cn(
              'relative rounded-2xl rounded-bl-sm border-[1.5px] border-dashed px-3 py-2',
              'border-amber-600 bg-amber-100/95 italic text-amber-900',
              'dark:border-amber-500 dark:bg-amber-950/80 dark:text-amber-200',
              'text-sm leading-snug shadow-sm',
              'animate-in fade-in slide-in-from-left-2 duration-300',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute -left-2 top-1/2 -translate-y-1/2',
                'h-0 w-0 border-y-[6px] border-r-[8px] border-y-transparent',
                'border-r-amber-100/95 dark:border-r-amber-950/80',
              )}
            />
            <span
              aria-hidden
              className={cn(
                'absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center',
                'rounded-full border border-dashed border-amber-600 bg-white text-[11px] not-italic',
                'dark:border-amber-500 dark:bg-slate-900',
              )}
            >
              💭
            </span>
            {innerThought}
          </div>
        ) : null}
      </div>
    </div>
  );
}
