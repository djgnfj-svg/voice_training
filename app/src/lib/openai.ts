import Anthropic from '@anthropic-ai/sdk';

const globalForAnthropic = globalThis as unknown as {
  anthropic: Anthropic | undefined;
};

const anthropic =
  globalForAnthropic.anthropic ??
  new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

if (process.env.NODE_ENV !== 'production') globalForAnthropic.anthropic = anthropic;

export { anthropic };

// Model constants
export const MODELS = {
  ANALYSIS: 'claude-haiku-4-5-20251001' as const,
  EVALUATION: 'claude-sonnet-4-6' as const,
  QUESTION_GEN: 'claude-sonnet-4-6' as const,
};

/**
 * OpenAI-compatible wrapper around Anthropic SDK.
 * All existing service code uses `openai.chat.completions.create(...)`,
 * so we keep that interface and translate internally.
 */
export const openai = {
  chat: {
    completions: {
      create: async (params: {
        model: string;
        messages: { role: string; content: string }[];
        response_format?: { type: string };
        temperature?: number;
      }) => {
        const userMessage = params.messages.find((m) => m.role === 'user')?.content || '';
        const systemMessage = params.messages.find((m) => m.role === 'system')?.content;

        const isJson = params.response_format?.type === 'json_object';
        const systemPrompt = [
          systemMessage,
          isJson ? 'You must respond with valid JSON only. No markdown, no explanation, just JSON.' : null,
        ]
          .filter(Boolean)
          .join('\n\n') || undefined;

        const response = await anthropic.messages.create({
          model: params.model,
          max_tokens: 4096,
          temperature: params.temperature ?? 0.5,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: [{ role: 'user', content: userMessage }],
        });

        const textBlock = response.content.find((b) => b.type === 'text');
        let content = textBlock ? textBlock.text : null;

        // Strip markdown code blocks if Claude wraps JSON in ```json ... ```
        if (content && isJson) {
          content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        }

        return {
          choices: [
            {
              message: {
                content,
              },
            },
          ],
        };
      },
    },
  },
};
