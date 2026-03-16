export function captureError(error: unknown, _context?: Record<string, unknown>): void {
  console.error(error);
}
