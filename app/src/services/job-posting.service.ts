import { Prisma } from '@prisma/client';
import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { getCached, setCache } from '@/lib/redis';
import { JOB_POSTING_ANALYSIS_PROMPT, COMPANY_ANALYSIS_PROMPT } from '@/prompts/job-posting';
import { DEEP_COMPANY_ANALYSIS_PROMPT } from '@/prompts/company-research';
import { searchCompanyInfo } from '@/lib/tavily';
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
        parsedData: parsedData as unknown as Prisma.InputJsonValue,
        companyAnalysis: companyAnalysis as unknown as Prisma.InputJsonValue,
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

  async deepCompanyResearch(
    company: string,
    position: string,
    techStack: string[],
  ): Promise<Partial<CompanyAnalysis>> {
    const searchResults = await searchCompanyInfo(company, position);
    if (!searchResults) {
      throw new Error('검색 결과를 가져올 수 없습니다');
    }

    const formattedResults = searchResults
      .map((sr) => {
        const items = sr.results.map((r) => `- [${r.title}](${r.url})\n  ${r.content}`).join('\n');
        return `### 검색: "${sr.query}"\n${sr.answer ? `요약: ${sr.answer}\n` : ''}${items}`;
      })
      .join('\n\n');

    const prompt = DEEP_COMPANY_ANALYSIS_PROMPT
      .replace('{company}', company)
      .replace('{position}', position)
      .replace('{techStack}', techStack.join(', '))
      .replace('{searchResults}', formattedResults);

    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('심층 분석 결과를 생성할 수 없습니다');

    return JSON.parse(content) as Partial<CompanyAnalysis>;
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
