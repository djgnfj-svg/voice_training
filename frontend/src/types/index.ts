// Interview Types
export type InterviewType = 'TECHNICAL' | 'BEHAVIORAL' | 'MIXED';
type Difficulty = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

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

interface ProjectExperience {
  name: string;
  description: string;
  techStack: string[];
  role?: string;
  period?: string;
}

interface WorkExperience {
  company: string;
  position: string;
  period: string;
  description: string;
}

// Interview Session
export interface InterviewQuestion {
  index: number;
  text: string;
  source: 'job_posting' | 'resume_based' | 'general' | 'deep_technical' | 'company_specific';
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

interface EvaluationScores {
  accuracy: number;      // 기술 정확성
  depth: number;         // 이해 깊이
  clarity: number;       // 전달 명확성
  completeness: number;  // 완성도
  practicality: number;  // 실무 적용력
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

interface GapAnalysis {
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
  audioUrl?: string;
}

interface SpeechAnalysis {
  averageResponseTime: number;
  fillerWordCount: number;
  speechRate: string;
  averageWpm?: number;
  totalSilenceSec?: number;
  averageSilenceRatio?: number;
}

// Resume list item
export interface ResumeItem {
  id: string;
  name: string;
  skills: string[];
  createdAt: string;
}

