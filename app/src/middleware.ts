export { auth as middleware } from '@/lib/auth';

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
