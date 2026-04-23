import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const sessionToken =
    request.cookies.get('__Secure-authjs.session-token') ??
    request.cookies.get('authjs.session-token');

  if (!sessionToken) {
    const { pathname } = request.nextUrl;
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Page routes only — API routes are proxied via next.config.ts rewrites
    '/dashboard/:path*',
    '/interview/:path*',
    '/agent-interview/:path*',
    '/nightly-study/:path*',
    '/profile/:path*',
    '/history/:path*',
    '/learn/:path*',
    '/progress/:path*',
  ],
};
