import { encode } from '@auth/core/jwt';

export interface AdminUserSeed {
  id: string;
  email: string;
  name: string;
}

export async function bakeSessionCookie(user: AdminUserSeed, salt: string): Promise<string> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET env required for E2E');
  return encode({
    token: { sub: user.id, email: user.email, name: user.name },
    secret,
    salt,
  });
}
