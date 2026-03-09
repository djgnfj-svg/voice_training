'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';
import { isAdmin } from '@/lib/admin';
import {
  LayoutDashboard,
  Mic,
  FileText,
  History,
  LogOut,
  BookOpen,
  Coins,
  AudioLines,
  Eye,
  MessageSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useMobileSidebar } from '@/hooks/useMobileSidebar';

const navItems = [
  { href: '/dashboard', label: '대시보드', icon: LayoutDashboard },
  { href: '/interview/setup', label: '면접 시작', icon: Mic },
  { href: '/interview/model-answer', label: '모범답안 학습', icon: BookOpen },
  { href: '/profile', label: '이력서 관리', icon: FileText },
  { href: '/credits', label: '크레딧', icon: Coins },
  { href: '/history', label: '면접 기록', icon: History },
];

const adminNavItems = [
  { href: '/admin/cunning', label: '컨닝 모드', icon: Eye },
  { href: '/admin/answer-assist', label: '답변 어시스트', icon: MessageSquare },
  { href: '/admin/voice-test', label: '음성 테스트', icon: AudioLines },
];

function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const showAdmin = isAdmin(session?.user?.email);

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-16 items-center border-b px-6">
        <Link href="/dashboard" className="flex items-center gap-2" onClick={onNavClick}>
          <Mic className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">보이스프렙</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavClick}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-primary/10 text-primary shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground hover:translate-x-0.5'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}

        {showAdmin && (
          <>
            <div className="my-3 border-t" />
            {adminNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavClick}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                    isActive
                      ? 'bg-primary/10 text-primary shadow-sm'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground hover:translate-x-0.5'
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {/* User section */}
      <div className="border-t p-3">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3"
          onClick={() => signOut({ callbackUrl: '/login' })}
        >
          <LogOut className="h-4 w-4" />
          <span>로그아웃</span>
        </Button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  if (pathname.startsWith('/interview/session/')) return null;

  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 border-r bg-card md:block">
      <SidebarContent />
    </aside>
  );
}

export function MobileSidebar() {
  const pathname = usePathname();
  const { isOpen, close } = useMobileSidebar();

  if (pathname.startsWith('/interview/session/')) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
      <SheetContent side="left" className="p-0">
        <SheetTitle className="sr-only">네비게이션 메뉴</SheetTitle>
        <SidebarContent onNavClick={close} />
      </SheetContent>
    </Sheet>
  );
}
