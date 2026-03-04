import { Prisma } from '@prisma/client';
import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { correctTranscript } from '@/lib/transcript-server';
import { TECHNICAL_EVALUATION_PROMPT, BEHAVIORAL_EVALUATION_PROMPT, DEEP_TECHNICAL_EVALUATION_PROMPT } from '@/prompts/evaluation';
import type { AnswerEvaluation, InterviewType } from '@/types';

export class EvaluationService {
  /** Claude 호출만 수행, DB 저장 안 함 */
  async evaluateStateless(params: {
    questionText: string;
    answerTranscript: string;
    interviewType: InterviewType;
    deepMode?: boolean;
    relatedKeyPoints?: string[];
  }): Promise<AnswerEvaluation> {
    const { questionText, answerTranscript, interviewType, deepMode, relatedKeyPoints } = params;

    const { correctedText, wasChanged } = await correctTranscript(answerTranscript, questionText);

    let promptTemplate: string;
    if (deepMode) {
      promptTemplate = DEEP_TECHNICAL_EVALUATION_PROMPT;
    } else if (interviewType === 'BEHAVIORAL') {
      promptTemplate = BEHAVIORAL_EVALUATION_PROMPT;
    } else {
      promptTemplate = TECHNICAL_EVALUATION_PROMPT;
    }

    let prompt = promptTemplate
      .replace('{question}', questionText)
      .replace('{answer}', correctedText);

    if (deepMode) {
      const keyPointsStr = relatedKeyPoints && relatedKeyPoints.length > 0
        ? relatedKeyPoints.map(kp => `- ${kp}`).join('\n')
        : '(참고 핵심 포인트 없음)';
      prompt = prompt.replace('{relatedKeyPoints}', keyPointsStr);
    }

    const response = await openai.chat.completions.create({
      model: MODELS.EVALUATION,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to evaluate answer');

    const evaluation = JSON.parse(content) as AnswerEvaluation;

    if (wasChanged) {
      evaluation.correctedTranscript = correctedText;
    }

    return evaluation;
  }

  async evaluateAnswer(params: {
    sessionId: string;
    questionIndex: number;
    answerTranscript: string;
    responseTimeSec?: number;
    deepMode?: boolean;
    relatedKeyPoints?: string[];
  }): Promise<AnswerEvaluation> {
    const { sessionId, questionIndex, answerTranscript, responseTimeSec, deepMode, relatedKeyPoints } = params;

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
      deepMode,
      relatedKeyPoints,
    });

    await prisma.interviewAnswer.update({
      where: {
        sessionId_questionIndex: { sessionId, questionIndex },
      },
      data: {
        answerTranscript: evaluation.correctedTranscript || answerTranscript,
        scores: evaluation.scores as unknown as Prisma.InputJsonValue,
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
