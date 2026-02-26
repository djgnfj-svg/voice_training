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
  User,
  LogOut,
  Briefcase,
  Eye,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const navItems = [
  { href: '/dashboard', label: '대시보드', icon: LayoutDashboard },
  { href: '/interview/setup', label: '면접 시작', icon: Mic },
  { href: '/interview/cunning', label: '컨닝 모드', icon: Eye },
  { href: '/profile', label: '이력서 관리', icon: FileText },
  { href: '/history', label: '면접 기록', icon: History },
  { href: '/analytics', label: '성장 분석', icon: TrendingUp },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 border-r bg-background">
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div className="flex h-16 items-center border-b px-6">
          <Link href="/dashboard" className="flex items-center gap-2">
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
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
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
    </aside>
  );
}
