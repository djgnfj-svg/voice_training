'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Coins, ShoppingCart, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import type { CreditInfo, CreditTransactionItem } from '@/types';

const PLANS = [
  { credits: 5, price: '3,000원' },
  { credits: 15, price: '8,000원' },
  { credits: 30, price: '14,000원' },
];

const TX_TYPE_LABELS: Record<string, string> = {
  FREE_TRIAL: '무료 체험',
  ADMIN_GRANT: '관리자 지급',
  PURCHASE: '결제 충전',
  SESSION_DEBIT: '세션 사용',
  REFUND: '환불',
};

export default function CreditsPage() {
  const { data: creditInfo } = useQuery<CreditInfo>({
    queryKey: ['credits'],
    queryFn: async () => {
      const res = await fetch('/api/credits');
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
  });

  const { data: transactions } = useQuery<CreditTransactionItem[]>({
    queryKey: ['credit-transactions'],
    queryFn: async () => {
      const res = await fetch('/api/credits/transactions');
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">크레딧</h1>
        <p className="text-muted-foreground">크레딧을 관리하고 충전하세요</p>
      </div>

      {/* Current Balance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            현재 잔액
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold">{creditInfo?.balance ?? 0}</span>
            <span className="text-lg text-muted-foreground">크레딧</span>
          </div>
          {creditInfo && !creditInfo.freeTrialUsed && (
            <p className="mt-2 text-sm text-green-600 dark:text-green-400">
              무료 체험 1회 사용 가능
            </p>
          )}
        </CardContent>
      </Card>

      {/* Purchase Plans */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            크레딧 충전
          </CardTitle>
          <CardDescription>원하는 크레딧 상품을 선택하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <div key={plan.credits} className="rounded-lg border p-4">
                <p className="text-2xl font-bold">{plan.credits} 크레딧</p>
                <p className="mt-1 text-lg text-muted-foreground">{plan.price}</p>
                <Button className="mt-3 w-full" disabled>
                  곧 출시
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Transaction History */}
      <Card>
        <CardHeader>
          <CardTitle>거래 내역</CardTitle>
          <CardDescription>크레딧 사용 및 충전 내역입니다</CardDescription>
        </CardHeader>
        <CardContent>
          {!transactions || transactions.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">거래 내역이 없습니다</p>
          ) : (
            <div className="space-y-3">
              {transactions.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-3">
                    {tx.amount >= 0 ? (
                      <ArrowDownLeft className="h-4 w-4 text-green-500" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4 text-red-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{TX_TYPE_LABELS[tx.type] ?? tx.type}</p>
                      {tx.description && (
                        <p className="text-xs text-muted-foreground">{tx.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-medium ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      잔액 {tx.balance} | {new Date(tx.createdAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
