import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { TECHNICAL_EVALUATION_PROMPT, BEHAVIORAL_EVALUATION_PROMPT } from '@/prompts/evaluation';
import type { AnswerEvaluation, InterviewType } from '@/types';

export class EvaluationService {
  /** Claude 호출만 수행, DB 저장 안 함 */
  async evaluateStateless(params: {
    questionText: string;
    answerTranscript: string;
    interviewType: InterviewType;
  }): Promise<AnswerEvaluation> {
    const { questionText, answerTranscript, interviewType } = params;

    const isBehavioral = interviewType === 'BEHAVIORAL';
    const promptTemplate = isBehavioral
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

    return JSON.parse(content) as AnswerEvaluation;
  }

  async evaluateAnswer(params: {
    sessionId: string;
    questionIndex: number;
    answerTranscript: string;
    responseTimeSec?: number;
  }): Promise<AnswerEvaluation> {
    const { sessionId, questionIndex, answerTranscript, responseTimeSec } = params;

    const session = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      include: { answers: true },
    });
    if (!session) throw new Error('Session not found');

    const existingAnswer = session.answers.find(a => a.questionIndex === questionIndex);
    const questionText = existingAnswer?.questionText || '';

    const evaluation = await this.evaluateStateless({
      questionText,
      answerTranscript,
      interviewType: session.type as InterviewType,
    });

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
