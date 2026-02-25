import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { QUESTION_GENERATION_PROMPT, GENERAL_QUESTION_PROMPT } from '@/prompts/question-generation';
import { matchingService } from './matching.service';
import type {
  InterviewQuestion,
  ParsedJobPosting,
  ParsedResume,
  CompanyAnalysis,
  MatchingAnalysis,
  InterviewType,
  Difficulty,
} from '@/types';

export class QuestionService {
  async generateQuestions(params: {
    type: InterviewType;
    categories: string[];
    difficulty: Difficulty;
    totalQuestions: number;
    jobPostingId?: string;
    userId: string;
  }): Promise<InterviewQuestion[]> {
    const { type, categories, difficulty, totalQuestions, jobPostingId, userId } = params;

    // If job posting exists, generate tailored questions
    if (jobPostingId) {
      return this.generateTailoredQuestions({
        type,
        categories,
        difficulty,
        totalQuestions,
        jobPostingId,
        userId,
      });
    }

    // Otherwise, generate general questions
    return this.generateGeneralQuestions({ type, categories, difficulty, totalQuestions });
  }

  private async generateTailoredQuestions(params: {
    type: InterviewType;
    categories: string[];
    difficulty: Difficulty;
    totalQuestions: number;
    jobPostingId: string;
    userId: string;
  }): Promise<InterviewQuestion[]> {
    const { type, categories, difficulty, totalQuestions, jobPostingId, userId } = params;

    // Fetch job posting data
    const jobPosting = await prisma.jobPosting.findUnique({
      where: { id: jobPostingId },
    });
    if (!jobPosting) throw new Error('Job posting not found');

    const parsedJobPosting = jobPosting.parsedData as unknown as ParsedJobPosting;
    const companyAnalysis = jobPosting.companyAnalysis as unknown as CompanyAnalysis;

    // Fetch user resume
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { parsedResume: true },
    });
    const parsedResume = user?.parsedResume as unknown as ParsedResume | null;

    // Matching analysis (if resume exists)
    let matchingAnalysis: MatchingAnalysis | null = null;
    if (parsedResume) {
      matchingAnalysis = await matchingService.analyzeMatch(parsedJobPosting, parsedResume);
    }

    const prompt = QUESTION_GENERATION_PROMPT
      .replace('{interviewType}', type)
      .replace('{categories}', categories.join(', '))
      .replace('{difficulty}', difficulty)
      .replace('{totalQuestions}', totalQuestions.toString())
      .replace('{parsedJobPosting}', JSON.stringify(parsedJobPosting, null, 2))
      .replace('{parsedResume}', parsedResume ? JSON.stringify(parsedResume, null, 2) : '이력서 없음')
      .replace('{matchingAnalysis}', matchingAnalysis ? JSON.stringify(matchingAnalysis, null, 2) : '매칭 분석 없음')
      .replace('{companyAnalysis}', companyAnalysis ? JSON.stringify(companyAnalysis, null, 2) : '회사 분석 없음');

    const response = await openai.chat.completions.create({
      model: MODELS.QUESTION_GEN,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to generate questions');

    const parsed = JSON.parse(content);
    const questions = Array.isArray(parsed) ? parsed : parsed.questions || [];

    return questions.map((q: any, index: number) => ({
      index,
      text: q.text,
      source: q.source || 'general',
      category: q.category || categories[0] || 'general',
      difficulty: q.difficulty || difficulty,
    }));
  }

  private async generateGeneralQuestions(params: {
    type: InterviewType;
    categories: string[];
    difficulty: Difficulty;
    totalQuestions: number;
  }): Promise<InterviewQuestion[]> {
    const { type, categories, difficulty, totalQuestions } = params;

    const prompt = GENERAL_QUESTION_PROMPT
      .replace('{interviewType}', type)
      .replace('{categories}', categories.join(', '))
      .replace('{difficulty}', difficulty)
      .replace('{totalQuestions}', totalQuestions.toString());

    const response = await openai.chat.completions.create({
      model: MODELS.QUESTION_GEN,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to generate questions');

    const parsed = JSON.parse(content);
    const questions = Array.isArray(parsed) ? parsed : parsed.questions || [];

    return questions.map((q: any, index: number) => ({
      index,
      text: q.text,
      source: 'general' as const,
      category: q.category || categories[0] || 'general',
      difficulty: q.difficulty || difficulty,
    }));
  }
}

export const questionService = new QuestionService();
