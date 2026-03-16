'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { GraduationCap, User } from 'lucide-react';
import type { ConversationMessage } from '@/hooks/useNightlyStudy';

function renderMarkdown(text: string) {
  // Split by code blocks first, then handle inline formatting
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="rounded bg-black/10 dark:bg-white/10 px-1 py-0.5 text-xs font-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    // Handle **bold**
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    return boldParts.map((bp, j) => {
      if (bp.startsWith('**') && bp.endsWith('**')) {
        return <strong key={`${i}-${j}`}>{bp.slice(2, -2)}</strong>;
      }
      return <span key={`${i}-${j}`}>{bp}</span>;
    });
  });
}

interface ConversationViewProps {
  messages: ConversationMessage[];
  isProcessing?: boolean;
  interimTranscript?: string;
}

export function ConversationView({ messages, isProcessing, interimTranscript }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, interimTranscript]);

  return (
    <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
      {messages.map((msg, idx) => (
        <div
          key={idx}
          className={cn(
            'flex gap-3',
            msg.role === 'user' ? 'flex-row-reverse' : 'flex-row',
          )}
        >
          {/* Avatar */}
          <div
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
              msg.role === 'tutor' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {msg.role === 'tutor' ? (
              <GraduationCap className="h-4 w-4" />
            ) : (
              <User className="h-4 w-4" />
            )}
          </div>

          {/* Bubble */}
          <div
            className={cn(
              'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
              msg.role === 'tutor'
                ? 'bg-muted text-foreground rounded-tl-sm'
                : 'bg-primary text-primary-foreground rounded-tr-sm',
            )}
          >
            {msg.role === 'tutor' ? renderMarkdown(msg.content) : msg.content}
          </div>
        </div>
      ))}

      {/* Interim transcript (currently being spoken) */}
      {interimTranscript && (
        <div className="flex flex-row-reverse gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <User className="h-4 w-4" />
          </div>
          <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-primary/60 px-4 py-2.5 text-sm text-primary-foreground">
            {interimTranscript}
          </div>
        </div>
      )}

      {/* Processing indicator */}
      {isProcessing && (
        <div className="flex gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <GraduationCap className="h-4 w-4" />
          </div>
          <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              생각하는 중
              <span className="animate-pulse">...</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
