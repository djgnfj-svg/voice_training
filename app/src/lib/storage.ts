import { createClient, SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'interview-audio';

const globalForStorage = globalThis as unknown as {
  supabaseStorage: SupabaseClient | undefined;
};

export const isStorageAvailable =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertSafePath(filePath: string): void {
  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error(`Unsafe storage path: ${filePath}`);
  }
}

function getClient(): SupabaseClient | null {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;

  if (!globalForStorage.supabaseStorage) {
    globalForStorage.supabaseStorage = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
  }
  return globalForStorage.supabaseStorage;
}

export async function uploadAudio(
  filePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  assertSafePath(filePath);
  const { error } = await client.storage.from(BUCKET).upload(filePath, buffer, {
    contentType,
    upsert: true,
  });

  if (error) throw error;

  return filePath;
}

export async function getAudioUrl(filePath: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  assertSafePath(filePath);
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(filePath, 3600);

  if (error) throw error;
  return data.signedUrl;
}

export async function deleteAudio(filePath: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  assertSafePath(filePath);
  const { error } = await client.storage.from(BUCKET).remove([filePath]);
  if (error) throw error;
}
