'use client';

import { useSession } from 'next-auth/react';
import { User, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MobileSidebar } from '@/components/layout/sidebar';
import { CreditBadge } from '@/components/credit/credit-badge';
import { useMobileSidebar } from '@/hooks/useMobileSidebar';

export function Header() {
  const { data: session } = useSession();
  const openSidebar = useMobileSidebar((s) => s.open);

  return (
    <>
      <MobileSidebar />
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/80 px-4 md:px-6 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={openSidebar}
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">메뉴 열기</span>
        </Button>
        <div className="hidden md:block" />
        <div className="flex items-center gap-3">
          <CreditBadge />
          <div className="flex items-center gap-2 text-sm">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 ring-2 ring-primary/5 transition-colors duration-200 hover:bg-primary/15">
              <User className="h-4 w-4 text-primary" />
            </div>
            <span className="font-medium">{session?.user?.name || '사용자'}</span>
          </div>
        </div>
      </header>
    </>
  );
}
