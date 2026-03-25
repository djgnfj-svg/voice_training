'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Cpu,
  FileCode,
  Blocks,
  Globe,
  Type,
  Database,
  Server,
} from 'lucide-react';

const CATEGORIES = [
  { id: 'CS_BASICS', label: 'CS 기초', icon: Cpu, description: '운영체제, 네트워크, 자료구조' },
  { id: 'JAVASCRIPT', label: 'JavaScript', icon: FileCode, description: '클로저, 비동기, 이벤트 루프' },
  { id: 'REACT', label: 'React', icon: Blocks, description: '훅, 상태 관리, 렌더링' },
  { id: 'NEXTJS', label: 'Next.js', icon: Globe, description: 'SSR, 라우팅, 미들웨어' },
  { id: 'TYPESCRIPT', label: 'TypeScript', icon: Type, description: '제네릭, 유틸리티 타입' },
  { id: 'DATABASE', label: '데이터베이스', icon: Database, description: '인덱스, 트랜잭션, 정규화' },
  { id: 'DEVOPS', label: 'DevOps', icon: Server, description: 'CI/CD, Docker, 모니터링' },
];

const MODES = [
  { id: 'deep' as const, label: '1개 깊게', description: '하나의 주제를 4~5라운드로 깊이 탐구' },
  { id: 'light' as const, label: '2개 가볍게', description: '두 주제를 2~3라운드씩 가볍게 복습' },
];

interface TopicSelectorProps {
  onStart: (categories: string[], mode: 'deep' | 'light') => void;
  disabled?: boolean;
}

export function TopicSelector({ onStart, disabled }: TopicSelectorProps) {
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedMode, setSelectedMode] = useState<'deep' | 'light'>('deep');

  const toggleCategory = (id: string) => {
    setSelectedCategories((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const canStart = selectedCategories.length > 0;

  return (
    <div className="space-y-6">
      {/* Category grid */}
      <Card>
        <CardHeader>
          <CardTitle>주제 선택</CardTitle>
          <CardDescription>학습할 기술 카테고리를 선택하세요 (복수 선택 가능)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {CATEGORIES.map((cat) => {
              const isSelected = selectedCategories.includes(cat.id);
              return (
                <button
                  key={cat.id}
                  onClick={() => toggleCategory(cat.id)}
                  disabled={disabled}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border-2 p-4 text-center transition-all',
                    isSelected
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : 'border-transparent bg-muted/50 hover:border-muted-foreground/25',
                    disabled && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <cat.icon className={cn('h-6 w-6', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                  <span className={cn('text-sm font-medium', isSelected && 'text-primary')}>{cat.label}</span>
                  <span className="text-xs text-muted-foreground">{cat.description}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Mode selection */}
      <Card>
        <CardHeader>
          <CardTitle>학습 모드</CardTitle>
          <CardDescription>오늘의 학습 스타일을 선택하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedMode(m.id)}
                disabled={disabled}
                className={cn(
                  'rounded-lg border-2 p-4 text-left transition-all',
                  selectedMode === m.id
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent bg-muted/50 hover:border-muted-foreground/25',
                  disabled && 'opacity-50 cursor-not-allowed',
                )}
              >
                <p className={cn('font-medium', selectedMode === m.id && 'text-primary')}>{m.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Start button */}
      <Button
        size="lg"
        className="w-full"
        disabled={!canStart || disabled}
        onClick={() => onStart(selectedCategories, selectedMode)}
      >
        학습 시작
      </Button>
    </div>
  );
}
