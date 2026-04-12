import { Sidebar } from '@/components/layout/sidebar';
import { AuthenticatedContent } from '@/components/layout/authenticated-content';

// 인증 필요 페이지 전체를 동적 렌더로 강제 (빌드 시 prerender 회피)
export const dynamic = 'force-dynamic';

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <AuthenticatedContent>{children}</AuthenticatedContent>
    </div>
  );
}
