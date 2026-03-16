export function captureError(error: unknown, context?: Record<string, unknown>): void {
  console.error(error);

  if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
    import('@sentry/nextjs').then((Sentry) => {
      Sentry.captureException(error, context ? { extra: context } : undefined);
    }).catch(() => {
      // Sentry not available
    });
  }
}
