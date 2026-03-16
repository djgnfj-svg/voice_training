import { env } from '@/lib/env';

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const adminEmails = env.ADMIN_EMAILS ?? [];
  return adminEmails.includes(email.toLowerCase());
}
