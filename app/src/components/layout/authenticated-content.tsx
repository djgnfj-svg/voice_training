'use client';

import { usePathname } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { Footer } from '@/components/layout/footer';

export function AuthenticatedContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isInterviewSession = pathname.startsWith('/interview/session/');

  if (isInterviewSession) {
    return (
      <main className="min-h-screen">{children}</main>
    );
  }

  return (
    <div className="md:pl-64">
      <Header />
      <main className="p-4 md:p-8">{children}</main>
      <Footer />
    </div>
  );
}
