import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SEC = 300; // 5 minutes

function checkLoginRateLimit(email: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const entry = loginAttempts.get(email);

  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(email, { count: 1, resetAt: now + LOGIN_WINDOW_SEC });
    return true;
  }

  entry.count += 1;
  return entry.count <= LOGIN_LIMIT;
}

const nextAuth = NextAuth({
  debug: process.env.NODE_ENV !== 'production' || !!process.env.AUTH_DEBUG,
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 24, // 24 hours
  },
  pages: {
    signIn: '/login',
  },
  logger: {
    error(error) {
      console.error('[NextAuth Error]', error);
    },
    warn(code) {
      console.warn('[NextAuth Warn]', code);
    },
  },
  providers: [
    Google({
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
        };
      },
    }),
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: '이메일', type: 'email' },
        password: { label: '비밀번호', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email as string;
        if (!checkLoginRateLimit(email)) return null;

        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user?.hashedPassword) return null;

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.hashedPassword,
        );

        if (!isValid) return null;

        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
      }
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },
  },
});

export const handlers = nextAuth.handlers;
export const signIn = nextAuth.signIn;
export const signOut = nextAuth.signOut;

export const auth = nextAuth.auth;
