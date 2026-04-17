import { z } from 'zod';

const serverEnvSchema = z.object({
  // Required
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().min(1, 'DIRECT_URL is required'),
  NEXTAUTH_SECRET: z.string().min(1, 'NEXTAUTH_SECRET is required'),
  AUTH_GOOGLE_ID: z.string().min(1, 'AUTH_GOOGLE_ID is required'),
  AUTH_GOOGLE_SECRET: z.string().min(1, 'AUTH_GOOGLE_SECRET is required'),

  // Optional
  NEXT_PUBLIC_GA_MEASUREMENT_ID: z.string().optional(),
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((val) =>
      val
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;

function validateEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    return {} as ServerEnv;
  }

  if (process.env.SKIP_ENV_VALIDATION === '1') {
    const raw = process.env as unknown as Record<string, string | undefined>;
    return {
      ...raw,
      ADMIN_EMAILS: (raw.ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    } as ServerEnv;
  }

  const result = serverEnvSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Missing or invalid environment variables:\n${formatted}`);
  }

  return result.data;
}

export const env = validateEnv();
