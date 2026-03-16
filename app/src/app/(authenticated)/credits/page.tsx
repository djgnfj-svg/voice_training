'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Coins, ShoppingCart, ArrowUpRight, ArrowDownLeft, Loader2, Gift } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { loadTossPayments, ANONYMOUS } from '@tosspayments/tosspayments-sdk';
import { PAYMENT_PRODUCTS } from '@/lib/payment-products';
import type { CreditInfo, CreditTransactionItem } from '@/types';

const TX_TYPE_LABELS: Record<string, string> = {
  FREE_TRIAL: '무료 체험',
  ADMIN_GRANT: '관리자 지급',
  PURCHASE: '결제 충전',
  SESSION_DEBIT: '세션 사용',
  REFUND: '환불',
  COUPON: '쿠폰 사용',
};

export default function CreditsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [loadingProductId, setLoadingProductId] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [couponLoading, setCouponLoading] = useState(false);

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

  const handlePurchase = async (productId: string) => {
    const clientKey = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY;
    if (!clientKey) {
      alert('결제 설정이 완료되지 않았습니다.');
      return;
    }

    setLoadingProductId(productId);

    try {
      // 1. 주문 생성
      const orderRes = await fetch('/api/payments/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });

      if (!orderRes.ok) {
        if (orderRes.status === 401) {
          router.push('/login');
          return;
        }
        const err = await orderRes.json();
        throw new Error(err.error || '주문 생성 실패');
      }

      const { orderId, amount, orderName } = await orderRes.json();

      // 2. Toss SDK 초기화 + 결제 요청
      const tossPayments = await loadTossPayments(clientKey);
      const payment = tossPayments.payment({ customerKey: ANONYMOUS });

      await payment.requestPayment({
        method: 'CARD',
        amount: { currency: 'KRW', value: amount },
        orderId,
        orderName,
        successUrl: `${window.location.origin}/credits/success`,
        failUrl: `${window.location.origin}/credits/fail`,
      });
    } catch (err) {
      console.error('[Payment Error]', err);
    } finally {
      setLoadingProductId(null);
    }
  };

  const handleRedeemCoupon = async () => {
    const code = couponCode.trim();
    if (!code) return;

    setCouponLoading(true);
    try {
      const res = await fetch('/api/coupons/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast({ title: data.error || '쿠폰 사용 실패', variant: 'destructive' });
        return;
      }

      toast({ title: data.message });
      setCouponCode('');
      queryClient.invalidateQueries({ queryKey: ['credits'] });
      queryClient.invalidateQueries({ queryKey: ['credit-transactions'] });
    } catch {
      toast({ title: '쿠폰 사용 중 오류가 발생했습니다.', variant: 'destructive' });
    } finally {
      setCouponLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">크레딧</h1>
        <p className="text-muted-foreground">음성 면접 크레딧을 관리하고 충전하세요</p>
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
            <span className="text-5xl font-bold text-primary">{creditInfo?.balance ?? 0}</span>
            <span className="text-lg text-muted-foreground">크레딧</span>
          </div>
          {creditInfo && !creditInfo.freeTrialUsed && (
            <p className="mt-2 text-sm text-green-600 dark:text-green-400">
              무료 체험 1회 사용 가능
            </p>
          )}
        </CardContent>
      </Card>

      {/* Coupon */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5" />
            쿠폰 사용
          </CardTitle>
          <CardDescription>쿠폰 코드를 입력하여 크레딧을 받으세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="쿠폰 코드 입력"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRedeemCoupon(); }}
              disabled={couponLoading}
              className="uppercase"
            />
            <Button
              onClick={handleRedeemCoupon}
              disabled={couponLoading || !couponCode.trim()}
              className="shrink-0"
            >
              {couponLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                '사용하기'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Purchase Plans */}
      <Card className="opacity-70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            크레딧 충전
            <Badge variant="secondary" className="ml-2">준비중</Badge>
          </CardTitle>
          <CardDescription>결제 시스템을 준비하고 있습니다. 곧 만나보실 수 있어요!</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            {PAYMENT_PRODUCTS.map((product) => (
              <div
                key={product.id}
                className={cn(
                  'relative rounded-lg border p-4 opacity-50',
                  product.id === 'credit_15' && 'border-primary ring-1 ring-primary/20'
                )}
              >
                {product.id === 'credit_15' && (
                  <Badge className="absolute -top-2.5 left-4 bg-primary">추천</Badge>
                )}
                <p className="text-2xl font-bold">{product.label}</p>
                <p className="mt-1 text-lg text-muted-foreground">{product.priceLabel}</p>
                <Button
                  className="mt-3 w-full"
                  disabled
                >
                  준비중
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-sm text-muted-foreground">1크레딧 = 면접 · 모범답안 중 1회 사용</p>
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
                    <p className={`text-sm font-medium ${tx.amount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
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
