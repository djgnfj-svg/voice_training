import { redis } from '@/lib/redis';

const BUCKETS = {
  'ai-heavy': { limit: 10, windowSec: 3600 },
  'ai-light': { limit: 60, windowSec: 3600 },
} as const;

type BucketName = keyof typeof BUCKETS;

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
}

// 인메모리 폴백 (Redis 미연결 시)
const memStore = new Map<string, { count: number; resetAt: number }>();

// 5분마다 만료 항목 정리
const cleanupInterval = setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, value] of memStore) {
    if (value.resetAt <= now) {
      memStore.delete(key);
    }
  }
}, 5 * 60 * 1000);
cleanupInterval.unref();

async function checkWithRedis(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult | null> {
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec);
    }
    const ttl = await redis.ttl(key);
    const resetAt = Math.floor(Date.now() / 1000) + Math.max(ttl, 0);
    return {
      success: count <= limit,
      remaining: Math.max(limit - count, 0),
      resetAt,
    };
  } catch {
    return null;
  }
}

function checkWithMemory(
  key: string,
  limit: number,
  windowSec: number,
): RateLimitResult {
  const now = Math.floor(Date.now() / 1000);
  const entry = memStore.get(key);

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowSec;
    memStore.set(key, { count: 1, resetAt });
    return { success: true, remaining: limit - 1, resetAt };
  }

  entry.count += 1;
  return {
    success: entry.count <= limit,
    remaining: Math.max(limit - entry.count, 0),
    resetAt: entry.resetAt,
  };
}

export async function checkRateLimit(
  userId: string,
  bucket: BucketName,
): Promise<RateLimitResult> {
  const { limit, windowSec } = BUCKETS[bucket];
  const key = `rate_limit:${bucket}:${userId}`;

  const redisResult = await checkWithRedis(key, limit, windowSec);
  if (redisResult) return redisResult;

  return checkWithMemory(key, limit, windowSec);
}
