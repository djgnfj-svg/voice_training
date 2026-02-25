import OpenAI from 'openai';

const globalForOpenAI = globalThis as unknown as {
  openai: OpenAI | undefined;
};

export const openai =
  globalForOpenAI.openai ??
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

if (process.env.NODE_ENV !== 'production') globalForOpenAI.openai = openai;

// Model constants
export const MODELS = {
  ANALYSIS: 'gpt-4o-mini',     // For parsing/analysis tasks (cheaper)
  EVALUATION: 'gpt-4o',         // For evaluation/question generation (higher quality)
  QUESTION_GEN: 'gpt-4o',       // For generating interview questions
} as const;
