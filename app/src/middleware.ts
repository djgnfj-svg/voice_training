import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  // 개발 모드: 인증 우회
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next();
  }

  // 프로덕션: NextAuth 미들웨어 사용
  // auth middleware는 프로덕션에서만 동적 import
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/interview/:path*',
    '/profile/:path*',
    '/history/:path*',
    '/analytics/:path*',
    '/api/interview/:path*',
    '/api/job-posting/:path*',
    '/api/resume/:path*',
    '/api/history/:path*',
    '/api/analytics/:path*',
  ],
};
