import { openai, MODELS } from '@/lib/openai';
import { MATCHING_ANALYSIS_PROMPT } from '@/prompts/matching';
import type { ParsedJobPosting, ParsedResume, MatchingAnalysis } from '@/types';

export class MatchingService {
  async analyzeMatch(
    parsedJobPosting: ParsedJobPosting,
    parsedResume: ParsedResume
  ): Promise<MatchingAnalysis> {
    const prompt = MATCHING_ANALYSIS_PROMPT
      .replace('{parsedJobPosting}', JSON.stringify(parsedJobPosting, null, 2))
      .replace('{parsedResume}', JSON.stringify(parsedResume, null, 2));

    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.4,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to analyze matching');

    return JSON.parse(content) as MatchingAnalysis;
  }
}

export const matchingService = new MatchingService();
