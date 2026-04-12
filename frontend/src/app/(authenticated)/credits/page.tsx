'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Coins, ShoppingCart, ArrowUpRight, ArrowDownLeft, Loader2, Gift, Mail, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { PAYMENT_PRODUCTS } from '@/lib/payment-products';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { CreditInfo, CreditTransactionItem } from '@/types';

const TX_TYPE_LABELS: Record<string, string> = {
  FREE_TRIAL: '무료 체험',
  ADMIN_GRANT: '관리자 지급',
  PURCHASE: '결제 충전',
  SESSION_DEBIT: '세션 사용',
  FEATURE_DEBIT: '기능 사용',
  REFUND: '환불',
  COUPON: '쿠폰 사용',
};

export default function CreditsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: session } = useSession();

  const [couponCode, setCouponCode] = useState('');
  const [couponLoading, setCouponLoading] = useState(false);

  const [wishlistOpen, setWishlistOpen] = useState(false);
  const [wishlistProductId, setWishlistProductId] = useState<string | null>(null);
  const [wishlistEmail, setWishlistEmail] = useState('');
  const [wishlistLoading, setWishlistLoading] = useState(false);
  const [wishlistDone, setWishlistDone] = useState(false);

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

  const openWishlist = (productId: string) => {
    setWishlistProductId(productId);
    setWishlistEmail(session?.user?.email ?? '');
    setWishlistDone(false);
    setWishlistOpen(true);
  };

  const submitWishlist = async () => {
    const email = wishlistEmail.trim();
    if (!email) {
      toast({ title: '이메일을 입력해주세요', variant: 'destructive' });
      return;
    }

    setWishlistLoading(true);
    try {
      const res = await fetch('/api/payments/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, productId: wishlistProductId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '등록 실패');
      }
      setWishlistDone(true);
    } catch (err) {
      toast({
        title: '등록에 실패했습니다',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setWishlistLoading(false);
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
        <p className="text-muted-foreground">음성 면접 크레딧을 관리하세요</p>
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

      {/* Purchase Plans (wishlist mode) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            크레딧 상품 (출시 예정)
          </CardTitle>
          <CardDescription>
            아직 결제가 준비되지 않았습니다. 출시 알림을 받으시려면 이메일을 등록해주세요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            {PAYMENT_PRODUCTS.map((product) => (
              <div
                key={product.id}
                className={cn(
                  'relative rounded-lg border p-4 transition-colors hover:border-primary/50',
                  product.id === 'credit_150' && 'border-primary ring-1 ring-primary/20'
                )}
              >
                {product.id === 'credit_150' && (
                  <Badge className="absolute -top-2.5 left-4 bg-primary">추천</Badge>
                )}
                <p className="text-2xl font-bold">{product.label}</p>
                <p className="mt-1 text-lg text-muted-foreground">{product.priceLabel}</p>
                <Button
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() => openWishlist(product.id)}
                >
                  <Mail className="mr-2 h-4 w-4" />
                  출시 알림 받기
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-sm text-muted-foreground">
            1크레딧 = 면접 · 모범답안 중 1회 사용
          </p>
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

      {/* Wishlist Dialog */}
      <Dialog open={wishlistOpen} onOpenChange={setWishlistOpen}>
        <DialogContent className="sm:max-w-md">
          {wishlistDone ? (
            <>
              <DialogHeader>
                <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                  <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
                </div>
                <DialogTitle className="text-center">등록 완료</DialogTitle>
                <DialogDescription className="text-center">
                  결제가 준비되면 가장 먼저 알려드릴게요.
                </DialogDescription>
              </DialogHeader>
              <div className="flex">
                <Button className="w-full" onClick={() => setWishlistOpen(false)}>
                  확인
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>출시 알림 받기</DialogTitle>
                <DialogDescription>
                  결제 기능이 준비되면 이메일로 알려드립니다.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 py-2">
                <Input
                  type="email"
                  placeholder="your@email.com"
                  value={wishlistEmail}
                  onChange={(e) => setWishlistEmail(e.target.value)}
                  disabled={wishlistLoading}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') submitWishlist(); }}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setWishlistOpen(false)}
                  disabled={wishlistLoading}
                >
                  취소
                </Button>
                <Button onClick={submitWishlist} disabled={wishlistLoading || !wishlistEmail.trim()}>
                  {wishlistLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : '등록하기'}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
