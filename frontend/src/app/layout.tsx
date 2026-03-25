import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/toaster';
import { GoogleAnalytics } from '@/components/analytics/google-analytics';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://reseeall.com'),
  title: {
    default: '보이스프렙 — 말하며 준비하는 개발자 면접',
    template: '%s | 보이스프렙',
  },
  description: '타이핑이 아니라 실제로 말하며 연습하는 AI 기술 면접 코치. 음성으로 답변하고, 꼬리질문으로 깊이를 파고들고, 실시간 피드백으로 성장합니다.',
  openGraph: {
    type: 'website',
    locale: 'ko_KR',
    siteName: '보이스프렙',
    title: '보이스프렙 — 말하며 준비하는 개발자 면접',
    description: '타이핑이 아니라 실제로 말하며 연습하는 AI 기술 면접 코치. 음성으로 답변하고, 꼬리질문으로 깊이를 파고들고, 실시간 피드백으로 성장합니다.',
  },
  twitter: {
    card: 'summary_large_image',
    title: '보이스프렙 — 말하며 준비하는 개발자 면접',
    description: '타이핑이 아니라 실제로 말하며 연습하는 AI 기술 면접 코치.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body className={inter.className}>
        <GoogleAnalytics />
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
