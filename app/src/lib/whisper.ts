import OpenAI from 'openai';

const globalForWhisper = globalThis as unknown as {
  whisperClient: OpenAI | undefined;
};

export const isWhisperAvailable = !!process.env.OPENAI_API_KEY;

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;

  if (!globalForWhisper.whisperClient) {
    globalForWhisper.whisperClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return globalForWhisper.whisperClient;
}

export async function transcribeAudio(audioFile: File): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const response = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file: audioFile,
    language: 'ko',
  });

  return response.text;
}
