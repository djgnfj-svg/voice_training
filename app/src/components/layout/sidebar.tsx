'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Mic,
  FileText,
  History,
  TrendingUp,
  LogOut,
  Briefcase,
  BookOpen,
  Coins,
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
  { href: '/analytics', label: '성장 분석', icon: TrendingUp },
];

function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-16 items-center border-b px-6">
        <Link href="/dashboard" className="flex items-center gap-2" onClick={onNavClick}>
          <Briefcase className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">면접 코치</span>
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
  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 border-r bg-card md:block">
      <SidebarContent />
    </aside>
  );
}

export function MobileSidebar() {
  const { isOpen, close } = useMobileSidebar();

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
      <SheetContent side="left" className="p-0">
        <SheetTitle className="sr-only">네비게이션 메뉴</SheetTitle>
        <SidebarContent onNavClick={close} />
      </SheetContent>
    </Sheet>
  );
}
