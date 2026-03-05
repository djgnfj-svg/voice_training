import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import {
  QUESTION_GENERATION_PROMPT,
  GENERAL_QUESTION_PROMPT,
  INTERVIEW_PLAN_PROMPT,
  RESUME_ONLY_PLAN_PROMPT,
  RESUME_ONLY_QUESTION_PROMPT,
  DEEP_INTERVIEW_PLAN_PROMPT,
  DEEP_INTERVIEW_QUESTION_PROMPT,
} from '@/prompts/question-generation';
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

import csBasics from '@/data/questions/cs-basics.json';
import javascript from '@/data/questions/javascript.json';
import react from '@/data/questions/react.json';
import nextjs from '@/data/questions/nextjs.json';
import typescriptAdvanced from '@/data/questions/typescript-advanced.json';
import databaseAdvanced from '@/data/questions/database-advanced.json';
import devops from '@/data/questions/devops.json';

interface BankQuestion {
  subcategory: string;
  difficulty: string;
  questionText: string;
  keyPoints: string[];
  deepDiveTopics?: string[];
}

interface QuestionBank {
  category: string;
  questions: BankQuestion[];
}

const ALL_QUESTION_BANKS: QuestionBank[] = [
  csBasics,
  javascript,
  react,
  nextjs,
  typescriptAdvanced as QuestionBank,
  databaseAdvanced as QuestionBank,
  devops as QuestionBank,
];

export interface InterviewPlan {
  type: InterviewType;
  categories: string[];
  difficulty: Difficulty;
  totalQuestions: number;
  reasoning: string;
  focusAreas?: string[];
}

export class QuestionService {
  /**
   * AI가 이력서(+선택적 채용공고)를 보고 면접 설정을 자동 결정
   */
  async planInterview(params: {
    resumeId: string;
    jobPostingId?: string;
    userId: string;
    deepMode?: boolean;
  }): Promise<InterviewPlan> {
    const { resumeId, jobPostingId, userId, deepMode } = params;

    // Fetch resume
    const resume = await prisma.resume.findFirst({
      where: { id: resumeId, userId },
    });
    if (!resume) throw new Error('Resume not found');
    const parsedResume = resume.parsedData as unknown as ParsedResume | null;

    if (deepMode) {
      return this.planDeepInterview(parsedResume);
    }

    if (jobPostingId) {
      // Job posting + resume flow
      return this.planWithJobPosting(jobPostingId, parsedResume);
    }

    // Resume-only flow
    return this.planWithResumeOnly(parsedResume);
  }

  private async planWithJobPosting(
    jobPostingId: string,
    parsedResume: ParsedResume | null
  ): Promise<InterviewPlan> {
    const jobPosting = await prisma.jobPosting.findUnique({
      where: { id: jobPostingId },
    });
    if (!jobPosting) throw new Error('Job posting not found');

    const parsedJobPosting = jobPosting.parsedData as unknown as ParsedJobPosting;
    const companyAnalysis = jobPosting.companyAnalysis as unknown as CompanyAnalysis;

    let matchingAnalysis: MatchingAnalysis | null = null;
    if (parsedResume) {
      matchingAnalysis = await matchingService.analyzeMatch(parsedJobPosting, parsedResume);
    }

    const prompt = INTERVIEW_PLAN_PROMPT
      .replace('{parsedJobPosting}', JSON.stringify(parsedJobPosting, null, 2))
      .replace('{companyAnalysis}', companyAnalysis ? JSON.stringify(companyAnalysis, null, 2) : '회사 분석 없음')
      .replace('{parsedResume}', parsedResume ? JSON.stringify(parsedResume, null, 2) : '이력서 없음')
      .replace('{matchingAnalysis}', matchingAnalysis ? JSON.stringify(matchingAnalysis, null, 2) : '매칭 분석 없음');

    return this.callPlanAPI(prompt);
  }

  private async planWithResumeOnly(parsedResume: ParsedResume | null): Promise<InterviewPlan> {
    if (!parsedResume) throw new Error('Resume has no parsed data');

    const prompt = RESUME_ONLY_PLAN_PROMPT
      .replace('{parsedResume}', JSON.stringify(parsedResume, null, 2));

    return this.callPlanAPI(prompt);
  }

  private async planDeepInterview(parsedResume: ParsedResume | null): Promise<InterviewPlan> {
    if (!parsedResume) throw new Error('Resume has no parsed data');

    const prompt = DEEP_INTERVIEW_PLAN_PROMPT
      .replace('{parsedResume}', JSON.stringify(parsedResume, null, 2));

    return this.callPlanAPI(prompt, true);
  }

  private async callPlanAPI(prompt: string, deepMode?: boolean): Promise<InterviewPlan> {
    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to plan interview');

    const plan = JSON.parse(content);

    const maxQuestions = deepMode ? 5 : 15;

    return {
      type: plan.type || 'TECHNICAL',
      categories: plan.categories || ['general'],
      difficulty: plan.difficulty || 'INTERMEDIATE',
      totalQuestions: Math.min(Math.max(plan.totalQuestions || (deepMode ? 4 : 5), 3), maxQuestions),
      reasoning: plan.reasoning || '',
      focusAreas: plan.focusAreas,
    };
  }

  async generateQuestions(params: {
    type: InterviewType;
    categories: string[];
    difficulty: Difficulty;
    totalQuestions: number;
    resumeId: string;
    jobPostingId?: string;
    userId: string;
    deepMode?: boolean;
  }): Promise<InterviewQuestion[]> {
    const { type, categories, difficulty, totalQuestions, resumeId, jobPostingId, userId, deepMode } = params;

    // Fetch resume
    const resume = await prisma.resume.findFirst({
      where: { id: resumeId, userId },
    });
    const parsedResume = resume?.parsedData as unknown as ParsedResume | null;

    if (deepMode && parsedResume) {
      return this.generateDeepQuestions({
        categories,
        difficulty,
        totalQuestions,
        parsedResume,
      });
    }

    if (jobPostingId) {
      return this.generateTailoredQuestions({
        type,
        categories,
        difficulty,
        totalQuestions,
        jobPostingId,
        parsedResume,
      });
    }

    if (parsedResume) {
      return this.generateResumeBasedQuestions({
        type,
        categories,
        difficulty,
        totalQuestions,
        parsedResume,
      });
    }

    // Fallback to general questions
    return this.generateGeneralQuestions({ type, categories, difficulty, totalQuestions });
  }

  private async generateTailoredQuestions(params: {
    type: InterviewType;
    categories: string[];
    difficulty: Difficulty;
    totalQuestions: number;
    jobPostingId: string;
    parsedResume: ParsedResume | null;
  }): Promise<InterviewQuestion[]> {
    const { type, categories, difficulty, totalQuestions, jobPostingId, parsedResume } = params;

    const jobPosting = await prisma.jobPosting.findUnique({
      where: { id: jobPostingId },
    });
    if (!jobPosting) throw new Error('Job posting not found');

    const parsedJobPosting = jobPosting.parsedData as unknown as ParsedJobPosting;
    const companyAnalysis = jobPosting.companyAnalysis as unknown as CompanyAnalysis;

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

    return this.callQuestionAPI(prompt, categories, difficulty);
  }

  private async generateResumeBasedQuestions(params: {
    type: InterviewType;
    categories: string[];
    difficulty: Difficulty;
    totalQuestions: number;
    parsedResume: ParsedResume;
  }): Promise<InterviewQuestion[]> {
    const { type, categories, difficulty, totalQuestions, parsedResume } = params;

    const prompt = RESUME_ONLY_QUESTION_PROMPT
      .replace('{interviewType}', type)
      .replace('{categories}', categories.join(', '))
      .replace('{difficulty}', difficulty)
      .replace('{totalQuestions}', totalQuestions.toString())
      .replace('{parsedResume}', JSON.stringify(parsedResume, null, 2));

    return this.callQuestionAPI(prompt, categories, difficulty);
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

    const questions = await this.callQuestionAPI(prompt, categories, difficulty);
    return questions.map((q) => ({ ...q, source: 'general' as const }));
  }

  matchBankTopics(skills: string[], difficulty: Difficulty): BankQuestion[] {
    const normalizedSkills = skills.map(s => s.toLowerCase());
    const minDifficulty = difficulty === 'ADVANCED' ? ['ADVANCED'] : ['INTERMEDIATE', 'ADVANCED'];

    const matched: BankQuestion[] = [];

    for (const bank of ALL_QUESTION_BANKS) {
      for (const q of bank.questions) {
        if (!minDifficulty.includes(q.difficulty)) continue;

        const subcatLower = q.subcategory.toLowerCase();
        const isMatch = normalizedSkills.some(skill =>
          subcatLower.includes(skill) || skill.includes(subcatLower)
        );

        if (isMatch) {
          matched.push(q);
        }
      }
    }

    // Limit to 10~15 items
    return matched.slice(0, 15);
  }

  private async generateDeepQuestions(params: {
    categories: string[];
    difficulty: Difficulty;
    totalQuestions: number;
    parsedResume: ParsedResume;
  }): Promise<InterviewQuestion[]> {
    const { categories, difficulty, totalQuestions, parsedResume } = params;

    // Extract skills from resume
    const skills = [
      ...parsedResume.skills,
      ...parsedResume.projects.flatMap(p => p.techStack),
    ];
    const uniqueSkills = [...new Set(skills)];

    // Match question bank topics
    const matchedTopics = this.matchBankTopics(uniqueSkills, difficulty);

    const matchedTopicsStr = matchedTopics.length > 0
      ? matchedTopics.map(t =>
          `- [${t.subcategory}/${t.difficulty}] ${t.questionText}\n  핵심포인트: ${t.keyPoints.join(', ')}${t.deepDiveTopics ? `\n  심화주제: ${t.deepDiveTopics.join(', ')}` : ''}`
        ).join('\n')
      : '(매칭된 주제 없음 — 이력서 기반으로 자유롭게 생성)';

    const prompt = DEEP_INTERVIEW_QUESTION_PROMPT
      .replace('{matchedTopics}', matchedTopicsStr)
      .replace('{categories}', categories.join(', '))
      .replace('{difficulty}', difficulty)
      .replace('{totalQuestions}', totalQuestions.toString())
      .replace('{parsedResume}', JSON.stringify(parsedResume, null, 2));

    return this.callQuestionAPI(prompt, categories, difficulty, true);
  }

  private async callQuestionAPI(
    prompt: string,
    categories: string[],
    difficulty: Difficulty,
    deepMode?: boolean,
    defaultSource?: string,
  ): Promise<InterviewQuestion[]> {
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
      source: q.source || defaultSource || (deepMode ? 'deep_technical' : 'general'),
      category: q.category || categories[0] || 'general',
      difficulty: q.difficulty || difficulty,
      ...(deepMode && q.relatedKeyPoints ? { relatedKeyPoints: q.relatedKeyPoints } : {}),
    }));
  }
}

export const questionService = new QuestionService();
