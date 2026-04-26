'use client';
import { useSession } from 'next-auth/react';
import { isAdminEmail } from '@/lib/admin';

export function useIsAdmin(): boolean {
  const { data } = useSession();
  return isAdminEmail(data?.user?.email);
}
