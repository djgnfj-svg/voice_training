'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { isAdmin } from '@/lib/admin';
import { useAnswerAssist } from '@/hooks/useAnswerAssist';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  CheckCircle2,
  Send,
  Sparkles,
  Copy,
  Check,
  Loader2,
  ArrowLeft,
  MessageSquare,
} from 'lucide-react';

export default function AnswerAssistChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { data: authSession } = useSession();
  const {
    session,
    isLoading,
    activeItemId,
    activeItem,
    setActiveItemId,
    isStreaming,
    streamingText,
    isCompiling,
    compilingText,
    sendMessage,
    compileAnswer,
  } = useAnswerAssist(sessionId);

  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-select first item
  useEffect(() => {
    if (session?.items.length && !activeItemId) {
      setActiveItemId(session.items[0].id);
    }
  }, [session, activeItemId, setActiveItemId]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeItem?.conversation, streamingText, compilingText]);

  if (!isAdmin(authSession?.user?.email)) {
    router.push('/dashboard');
    return null;
  }

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <p className="text-muted-foreground">세션을 찾을 수 없습니다</p>
      </div>
    );
  }

  const handleSend = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const conversation = activeItem?.conversation ?? [];
  const finalAnswer = activeItem?.finalAnswer;
  const hasConversation = conversation.length > 0;

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/admin/answer-assist')}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          목록
        </Button>
        <h1 className="text-lg font-bold">답변 어시스트</h1>
      </div>

      <div className="flex gap-4" style={{ height: 'calc(100vh - 180px)' }}>
        {/* Left: Question list */}
        <div className="w-72 shrink-0 overflow-y-auto rounded-lg border bg-card">
          <div className="border-b p-3">
            <p className="text-sm font-medium text-muted-foreground">질문 목록</p>
          </div>
          <div className="space-y-1 p-2">
            {session.items.map((item, i) => (
              <button
                key={item.id}
                onClick={() => setActiveItemId(item.id)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md p-2.5 text-left text-sm transition-colors',
                  activeItemId === item.id
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-accent text-muted-foreground'
                )}
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {i + 1}
                </span>
                <span className="line-clamp-2 flex-1">{item.questionText}</span>
                {item.isCompleted && (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Chat interface */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border bg-card">
          {activeItem ? (
            <>
              {/* Question header */}
              <div className="border-b p-4">
                <p className="text-sm font-medium">{activeItem.questionText}</p>
              </div>

              {/* Chat messages */}
              <div className="flex-1 overflow-y-auto p-4">
                <div className="space-y-4">
                  {conversation.map((msg, i) => (
                    <div
                      key={i}
                      className={cn(
                        'flex',
                        msg.role === 'user' ? 'justify-end' : 'justify-start'
                      )}
                    >
                      <div
                        className={cn(
                          'max-w-[80%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap',
                          msg.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted'
                        )}
                      >
                        {msg.content}
                      </div>
                    </div>
                  ))}

                  {isStreaming && streamingText && (
                    <div className="flex justify-start">
                      <div className="max-w-[80%] rounded-lg bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">
                        {streamingText}
                      </div>
                    </div>
                  )}

                  {isStreaming && !streamingText && (
                    <div className="flex justify-start">
                      <div className="rounded-lg bg-muted px-4 py-2.5">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    </div>
                  )}

                  {/* Compiling indicator */}
                  {isCompiling && (
                    <Card className="border-primary/20 bg-primary/5">
                      <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-sm">
                          <Sparkles className="h-4 w-4 text-primary" />
                          최종 답변 정리 중...
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm whitespace-pre-wrap">
                          {compilingText || '...'}
                        </p>
                      </CardContent>
                    </Card>
                  )}

                  {/* Final answer */}
                  {finalAnswer && !isCompiling && (
                    <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="flex items-center gap-2 text-sm">
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                            최종 답변
                          </CardTitle>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCopy(finalAnswer)}
                          >
                            {copied ? (
                              <Check className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm whitespace-pre-wrap">{finalAnswer}</p>
                      </CardContent>
                    </Card>
                  )}

                  <div ref={chatEndRef} />
                </div>
              </div>

              {/* Input area */}
              <div className="border-t p-4">
                <div className="flex gap-2">
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="답변을 입력하세요... (Enter로 전송, Shift+Enter로 줄바꿈)"
                    rows={2}
                    disabled={isStreaming || isCompiling}
                    className="resize-none"
                  />
                  <div className="flex flex-col gap-2">
                    <Button
                      size="sm"
                      onClick={handleSend}
                      disabled={!input.trim() || isStreaming || isCompiling}
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                    {hasConversation && !finalAnswer && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={compileAnswer}
                        disabled={isStreaming || isCompiling}
                        title="대화를 종합하여 최종 답변 생성"
                      >
                        <Sparkles className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center text-muted-foreground">
                <MessageSquare className="mx-auto mb-2 h-8 w-8" />
                <p className="text-sm">왼쪽에서 질문을 선택하세요</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
