'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { Card, CardContent } from '@/components/ui/card';
import { Smartphone } from 'lucide-react';

export default function MobileOnlyPage() {
  const [url, setUrl] = useState('');

  useEffect(() => {
    setUrl(window.location.origin + '/nightly-study');
  }, []);

  const qr = url
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`
    : '';

  return (
    <div className="mx-auto max-w-md space-y-6 p-8">
      <div className="text-center">
        <Smartphone className="mx-auto h-12 w-12 text-primary" />
        <h1 className="mt-4 text-2xl font-bold">모바일에서 열어주세요</h1>
        <p className="mt-2 text-muted-foreground">
          오늘의 학습은 음성 대화 기반이라 휴대폰에서 가장 자연스러워요.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-6">
          {qr ? <Image src={qr} alt="QR" width={192} height={192} unoptimized /> : null}
          <p className="text-sm text-muted-foreground break-all text-center">{url}</p>
        </CardContent>
      </Card>
    </div>
  );
}
