export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export async function onRequestError(
  error: { digest: string } & Error,
  request: {
    path: string;
    method: string;
    headers: Record<string, string>;
  },
  context: { routerKind: string; routePath: string; routeType: string; renderSource: string },
) {
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureException(error, {
    extra: { request, context },
  });
}
