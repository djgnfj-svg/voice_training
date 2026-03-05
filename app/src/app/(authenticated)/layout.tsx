import { Sidebar } from '@/components/layout/sidebar';
import { AuthenticatedContent } from '@/components/layout/authenticated-content';

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
