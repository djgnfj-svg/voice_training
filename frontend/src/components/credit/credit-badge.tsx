'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Coins } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CreditInfo } from '@/types';

export function CreditBadge() {
  const { data } = useQuery<CreditInfo>({
    queryKey: ['credits'],
    queryFn: async () => {
      const res = await fetch('/api/credits');
      if (!res.ok) throw new Error('Failed to fetch credits');
      return res.json();
    },
    staleTime: 30_000,
  });

  if (!data) return null;

  const hasFreeTrial = !data.freeTrialUsed;
  const isEmpty = data.balance === 0 && !hasFreeTrial;

  return (
    <Link
      href="/credits"
      className={cn(
        'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
        hasFreeTrial
          ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400'
          : isEmpty
            ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400'
            : 'bg-primary/10 text-primary hover:bg-primary/20',
      )}
    >
      <Coins className="h-3.5 w-3.5" />
      {hasFreeTrial ? '무료 1회' : data.balance}
    </Link>
  );
}
