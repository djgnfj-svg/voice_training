import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { TECHNICAL_EVALUATION_PROMPT, BEHAVIORAL_EVALUATION_PROMPT } from '@/prompts/evaluation';
import type { AnswerEvaluation } from '@/types';

export class EvaluationService {
  async evaluateAnswer(params: {
    sessionId: string;
    questionIndex: number;
    answerTranscript: string;
    responseTimeSec?: number;
  }): Promise<AnswerEvaluation> {
    const { sessionId, questionIndex, answerTranscript, responseTimeSec } = params;

    // Get session and existing answer data
    const session = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      include: { answers: true },
    });
    if (!session) throw new Error('Session not found');

    // Get the question from existing answers or session data
    const existingAnswer = session.answers.find(a => a.questionIndex === questionIndex);
    const questionText = existingAnswer?.questionText || '';

    // Choose prompt based on interview type
    const isBeahvioral = session.type === 'BEHAVIORAL';
    const promptTemplate = isBeahvioral
      ? BEHAVIORAL_EVALUATION_PROMPT
      : TECHNICAL_EVALUATION_PROMPT;

    const prompt = promptTemplate
      .replace('{question}', questionText)
      .replace('{answer}', answerTranscript);

    const response = await openai.chat.completions.create({
      model: MODELS.EVALUATION,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to evaluate answer');

    const evaluation: AnswerEvaluation = JSON.parse(content);

    // Save to database
    await prisma.interviewAnswer.update({
      where: {
        sessionId_questionIndex: { sessionId, questionIndex },
      },
      data: {
        answerTranscript,
        scores: evaluation.scores as any,
        overallScore: evaluation.overallScore,
        briefFeedback: evaluation.briefFeedback,
        detailedFeedback: evaluation.detailedFeedback,
        modelAnswer: evaluation.modelAnswer,
        followUpQuestion: evaluation.followUpQuestion,
        responseTimeSec,
      },
    });

    return evaluation;
  }
}

export const evaluationService = new EvaluationService();
