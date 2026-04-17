import { NextRequest, NextResponse } from 'next/server';

function isMobileUA(ua: string): boolean {
  return /Mobi|Android.*Mobile|iPhone|iPod|IEMobile|Windows Phone/.test(ua);
}

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

  // Mobile-only gate for /nightly-study
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/nightly-study') && !pathname.startsWith('/nightly-study/mobile-only')) {
    const ua = request.headers.get('user-agent') || '';
    if (!isMobileUA(ua)) {
      return NextResponse.redirect(new URL('/nightly-study/mobile-only', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Page routes only — API routes are proxied via next.config.ts rewrites
    '/dashboard/:path*',
    '/interview/:path*',
    '/agent-interview/:path*',
    '/journal/:path*',
    '/nightly-study/:path*',
    '/profile/:path*',
    '/history/:path*',
    '/credits/:path*',
    '/admin/:path*',
    '/learn/:path*',
    '/progress/:path*',
  ],
};
