import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getGrade } from '@/lib/utils';
import { countFillerWords } from '@/lib/transcript';
import type { InterviewReport, GapAnalysis, AnswerReport, SpeechAnalysis, EvaluationScores, ParsedJobPosting } from '@/types';

export class ReportService {
  async generateReport(sessionId: string, userId?: string): Promise<InterviewReport> {
    const session = await prisma.interviewSession.findUnique({
      where: { id: sessionId, ...(userId ? { userId } : {}) },
      include: {
        answers: { orderBy: { questionIndex: 'asc' } },
        jobPosting: true,
      },
    });

    if (!session) throw new Error('Session not found');

    const answeredQuestions = session.answers.filter(a => a.answerTranscript && a.answerTranscript !== '(건너뜀)');

    // Calculate overall score
    const scores = answeredQuestions
      .map(a => a.overallScore)
      .filter((s): s is number => s !== null);
    const overallScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

    // Category scores (average per category)
    const categorySums: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    for (const answer of answeredQuestions) {
      const source = answer.questionSource;
      if (!categorySums[source]) { categorySums[source] = 0; categoryCounts[source] = 0; }
      categorySums[source] += answer.overallScore || 0;
      categoryCounts[source] += 1;
    }
    const categoryScores: Record<string, number> = {};
    for (const source of Object.keys(categorySums)) {
      categoryScores[source] = Math.round(categorySums[source] / categoryCounts[source]);
    }

    // Strengths and improvements
    const sortedAnswers = [...answeredQuestions].sort(
      (a, b) => (b.overallScore || 0) - (a.overallScore || 0)
    );
    const strengths = sortedAnswers.slice(0, 3).map(a => a.briefFeedback || '');
    const improvements = sortedAnswers.slice(-3).reverse().map(a => a.briefFeedback || '');

    // Speech analysis
    const responseTimes = answeredQuestions
      .map(a => a.responseTimeSec)
      .filter((t): t is number => t !== null);
    const avgResponseTime = responseTimes.length > 0
      ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
      : 0;

    // Filler word count from actual transcripts
    const totalFillerWords = answeredQuestions.reduce((sum, a) => {
      return sum + countFillerWords(a.answerTranscript || '');
    }, 0);

    // WPM-based speech rate: Korean characters / response time
    const wpmValues = answeredQuestions
      .filter(a => a.responseTimeSec && a.responseTimeSec > 0 && a.answerTranscript)
      .map(a => {
        const charCount = (a.answerTranscript || '').replace(/[\s.,!?;:'"()\-]/g, '').length;
        const minutes = (a.responseTimeSec as number) / 60;
        return minutes > 0 ? charCount / minutes : 0;
      });
    const averageWpm = wpmValues.length > 0
      ? Math.round(wpmValues.reduce((a, b) => a + b, 0) / wpmValues.length)
      : 0;

    const speechRateLabel = averageWpm < 200 ? '느림' : averageWpm > 350 ? '빠름' : '적정';

    const speechAnalysis: SpeechAnalysis = {
      averageResponseTime: avgResponseTime,
      fillerWordCount: totalFillerWords,
      speechRate: speechRateLabel,
      averageWpm: averageWpm || undefined,
    };

    // Gap analysis (if job posting exists)
    let gapAnalysis: GapAnalysis | undefined;
    let matchingScore: number | undefined;
    if (session.jobPosting?.parsedData) {
      const parsedData = session.jobPosting.parsedData as unknown as ParsedJobPosting;
      const techStack = parsedData.techStack || [];
      const answeredTopics = answeredQuestions.map(a => a.questionText.toLowerCase());

      const coveredSkills = techStack.filter(skill =>
        answeredTopics.some(t => t.includes(skill.toLowerCase()))
      );

      matchingScore = techStack.length > 0
        ? Math.round((coveredSkills.length / techStack.length) * 100)
        : undefined;

      gapAnalysis = {
        missingSkills: techStack.filter(s => !coveredSkills.includes(s)),
        weakAreas: sortedAnswers
          .filter(a => (a.overallScore || 0) < 60)
          .map(a => a.questionText.slice(0, 50)),
        suggestions: [],
        coveragePercentage: matchingScore || 0,
      };
    }

    // Build answer reports
    const answerReports: AnswerReport[] = session.answers.map(a => ({
      questionIndex: a.questionIndex,
      questionText: a.questionText,
      questionSource: a.questionSource,
      answerTranscript: a.answerTranscript || '',
      scores: (a.scores as unknown as EvaluationScores) || {
        accuracy: 0, depth: 0, clarity: 0, completeness: 0, practicality: 0,
      },
      overallScore: a.overallScore || 0,
      briefFeedback: a.briefFeedback || '',
      detailedFeedback: a.detailedFeedback || '',
      modelAnswer: a.modelAnswer || '',
      responseTimeSec: a.responseTimeSec || undefined,
      followUpQuestion: a.followUpQuestion || undefined,
      audioUrl: a.audioUrl || undefined,
    }));

    const report: InterviewReport = {
      sessionId,
      overallScore,
      grade: getGrade(overallScore),
      matchingScore,
      gapAnalysis,
      categoryScores,
      strengths: strengths.filter(Boolean),
      improvements: improvements.filter(Boolean),
      answers: answerReports,
      speechAnalysis,
    };

    // Save report to session
    await prisma.interviewSession.update({
      where: { id: sessionId },
      data: {
        overallScore,
        matchingScore,
        gapAnalysis: gapAnalysis as unknown as Prisma.InputJsonValue,
        reportData: report as unknown as Prisma.InputJsonValue,
      },
    });

    return report;
  }
}

export const reportService = new ReportService();
