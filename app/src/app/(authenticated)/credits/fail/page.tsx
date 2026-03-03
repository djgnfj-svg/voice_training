'use client';

import { Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { XCircle, Loader2 } from 'lucide-react';

function FailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const code = searchParams.get('code') ?? '';
  const message = searchParams.get('message') ?? '결제에 실패했습니다.';

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center justify-center gap-2 text-red-600">
          <XCircle className="h-6 w-6" />
          결제 실패
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        <p className="text-center text-muted-foreground">{message}</p>
        {code && (
          <p className="text-xs text-muted-foreground">오류 코드: {code}</p>
        )}
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => router.push('/credits')}>
            돌아가기
          </Button>
          <Button onClick={() => router.push('/credits')}>다시 시도</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PaymentFailPage() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Suspense
        fallback={
          <Card className="mx-auto max-w-md">
            <CardContent className="flex flex-col items-center gap-4 py-12">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
            </CardContent>
          </Card>
        }
      >
        <FailContent />
      </Suspense>
    </div>
  );
}
