// Interview Types
export type InterviewType = 'TECHNICAL' | 'BEHAVIORAL' | 'MIXED';
export type Difficulty = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
export type SessionStatus = 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';

// Job Posting
export interface ParsedJobPosting {
  company: string;
  position: string;
  requirements: string[];
  preferred: string[];
  techStack: string[];
  duties: string[];
  teamInfo?: string;
  culture?: string[];
}

export interface CompanyAnalysis {
  interviewStyle: string;
  culture: string[];
  pastQuestionTrends: string[];
}

// Resume
export interface ParsedResume {
  name: string;
  education: string[];
  skills: string[];
  projects: ProjectExperience[];
  experience: WorkExperience[];
  summary?: string;
}

export interface ProjectExperience {
  name: string;
  description: string;
  techStack: string[];
  role?: string;
  period?: string;
}

export interface WorkExperience {
  company: string;
  position: string;
  period: string;
  description: string;
}

// Matching Analysis
export interface MatchingAnalysis {
  strengths: MatchItem[];
  weaknesses: MatchItem[];
  gaps: MatchItem[];
  overallMatchScore: number;
}

export interface MatchItem {
  area: string;
  detail: string;
  relevance: 'high' | 'medium' | 'low';
}

// Interview Session
export interface InterviewQuestion {
  index: number;
  text: string;
  source: 'job_posting' | 'resume_based' | 'general' | 'deep_technical';
  category: string;
  difficulty: Difficulty;
  relatedKeyPoints?: string[];
}

export interface AnswerEvaluation {
  scores: EvaluationScores;
  overallScore: number;
  briefFeedback: string;
  detailedFeedback: string;
  modelAnswer: string;
  followUpQuestion?: string;
  correctedTranscript?: string;
}

export interface EvaluationScores {
  accuracy: number;      // 기술 정확성
  depth: number;         // 이해 깊이
  clarity: number;       // 전달 명확성
  completeness: number;  // 완성도
  practicality: number;  // 실무 적용력
}

// Behavioral interview STAR scores
export interface BehavioralScores {
  situation: number;
  task: number;
  action: number;
  result: number;
  communication: number;
}

// Report
export interface InterviewReport {
  sessionId: string;
  overallScore: number;
  grade: string;
  matchingScore?: number;
  gapAnalysis?: GapAnalysis;
  categoryScores: Record<string, number>;
  strengths: string[];
  improvements: string[];
  answers: AnswerReport[];
  speechAnalysis?: SpeechAnalysis;
}

export interface GapAnalysis {
  missingSkills: string[];
  weakAreas: string[];
  suggestions: string[];
  coveragePercentage: number;
}

export interface AnswerReport {
  questionIndex: number;
  questionText: string;
  questionSource: string;
  answerTranscript: string;
  scores: EvaluationScores;
  overallScore: number;
  briefFeedback: string;
  detailedFeedback: string;
  modelAnswer: string;
  responseTimeSec?: number;
  followUpQuestion?: string;
}

export interface SpeechAnalysis {
  averageResponseTime: number;
  fillerWordCount: number;
  speechRate: string;
}

// Analytics
export interface GrowthData {
  date: string;
  score: number;
  sessionId: string;
  type: InterviewType;
}

export interface CategoryPerformance {
  category: string;
  averageScore: number;
  totalQuestions: number;
}

// Interview Categories
export const TECHNICAL_CATEGORIES = {
  CS_BASICS: {
    label: 'CS 기초',
    subcategories: ['운영체제', '네트워크', '데이터베이스', '자료구조', '알고리즘'],
  },
  LANGUAGES: {
    label: '프로그래밍 언어',
    subcategories: ['Java', 'Python', 'JavaScript/TypeScript'],
  },
  FRAMEWORKS: {
    label: '프레임워크',
    subcategories: ['React', 'Spring Boot', 'NestJS', 'Next.js'],
  },
  SYSTEM_DESIGN: {
    label: '시스템 설계',
    subcategories: ['Junior', 'Mid', 'Senior'],
  },
  DEVOPS: {
    label: 'DevOps',
    subcategories: ['Docker', 'CI/CD', 'Cloud'],
  },
} as const;

export const BEHAVIORAL_CATEGORIES = {
  SELF_INTRO: { label: '자기소개' },
  TEAMWORK: { label: '팀워크/갈등해결' },
  PROBLEM_SOLVING: { label: '문제해결 경험' },
  LEADERSHIP: { label: '리더십' },
  MOTIVATION: { label: '지원동기/경력목표' },
  PROJECT: { label: '프로젝트 경험 심층' },
} as const;

// Resume list item
export interface ResumeItem {
  id: string;
  name: string;
  skills: string[];
  createdAt: string;
}

// API Request/Response types
export interface SetupInterviewRequest {
  resumeId: string;
  jobPostingId?: string;
  deepMode?: boolean;
}

export interface EvaluateAnswerRequest {
  sessionId: string;
  questionIndex: number;
  answerTranscript: string;
  responseTimeSec?: number;
}

export interface AnalyzeJobPostingRequest {
  rawText: string;
}

// Credits
export interface CreditInfo {
  balance: number;
  freeTrialUsed: boolean;
}

export interface CreditTransactionItem {
  id: string;
  amount: number;
  balance: number;
  type: string;
  description: string | null;
  referenceId: string | null;
  createdAt: string;
}
