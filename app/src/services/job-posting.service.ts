import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { getCached, setCache } from '@/lib/redis';
import { JOB_POSTING_ANALYSIS_PROMPT, COMPANY_ANALYSIS_PROMPT } from '@/prompts/job-posting';
import type { ParsedJobPosting, CompanyAnalysis } from '@/types';

export class JobPostingService {
  async analyzeJobPosting(userId: string, rawText: string) {
    // Create DB record
    const jobPosting = await prisma.jobPosting.create({
      data: { userId, rawText },
    });

    // Parse job posting with GPT
    const parsedData = await this.parseJobPosting(rawText);

    // Analyze company
    const companyAnalysis = await this.analyzeCompany(
      parsedData.company,
      parsedData.position,
      parsedData.techStack
    );

    // Update DB
    const updated = await prisma.jobPosting.update({
      where: { id: jobPosting.id },
      data: {
        parsedData: parsedData as any,
        companyAnalysis: companyAnalysis as any,
      },
    });

    return updated;
  }

  private async parseJobPosting(rawText: string): Promise<ParsedJobPosting> {
    const prompt = JOB_POSTING_ANALYSIS_PROMPT.replace('{jobPostingText}', rawText);

    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to parse job posting');

    return JSON.parse(content) as ParsedJobPosting;
  }

  private async analyzeCompany(
    company: string,
    position: string,
    techStack: string[]
  ): Promise<CompanyAnalysis> {
    const cacheKey = `company:${company}:${position}`;
    const cached = await getCached<CompanyAnalysis>(cacheKey);
    if (cached) return cached;

    const prompt = COMPANY_ANALYSIS_PROMPT
      .replace('{company}', company)
      .replace('{position}', position)
      .replace('{techStack}', techStack.join(', '));

    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.5,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to analyze company');

    const analysis = JSON.parse(content) as CompanyAnalysis;
    await setCache(cacheKey, analysis, 86400); // Cache for 24h
    return analysis;
  }

  async getJobPosting(id: string) {
    return prisma.jobPosting.findUnique({ where: { id } });
  }

  async getUserJobPostings(userId: string) {
    return prisma.jobPosting.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

export const jobPostingService = new JobPostingService();
