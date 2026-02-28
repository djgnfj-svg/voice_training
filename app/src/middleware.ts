import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  // 개발 모드: 인증 우회
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next();
  }

  // 프로덕션: 세션 쿠키 체크
  const sessionToken =
    request.cookies.get('__Secure-authjs.session-token') ??
    request.cookies.get('authjs.session-token');

  if (!sessionToken) {
    const { pathname } = request.nextUrl;

    // API 요청은 401 반환
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 페이지 요청은 /login으로 리디렉트
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/interview/:path*',
    '/profile/:path*',
    '/history/:path*',
    '/analytics/:path*',
    '/credits/:path*',
    '/api/interview/:path*',
    '/api/job-posting/:path*',
    '/api/resume/:path*',
    '/api/history/:path*',
    '/api/analytics/:path*',
    '/api/credits/:path*',
    '/api/cunning/:path*',
    '/api/model-answer/:path*',
  ],
};
