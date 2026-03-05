import { Prisma } from '@prisma/client';
import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { correctTranscript } from '@/lib/transcript-server';
import { TECHNICAL_EVALUATION_PROMPT, BEHAVIORAL_EVALUATION_PROMPT, DEEP_TECHNICAL_EVALUATION_PROMPT, FOLLOWUP_EVALUATION_PROMPT } from '@/prompts/evaluation';
import type { AnswerEvaluation, InterviewType } from '@/types';

export class EvaluationService {
  /** Claude 호출만 수행, DB 저장 안 함 */
  async evaluateStateless(params: {
    questionText: string;
    answerTranscript: string;
    interviewType: InterviewType;
    deepMode?: boolean;
    relatedKeyPoints?: string[];
    previousContext?: {
      originalQuestion: string;
      originalAnswer: string;
      followUpHistory: { question: string; answer: string }[];
    };
  }): Promise<AnswerEvaluation> {
    const { questionText, answerTranscript, interviewType, deepMode, relatedKeyPoints, previousContext } = params;

    const { correctedText, wasChanged } = await correctTranscript(answerTranscript, questionText);

    let promptTemplate: string;
    if (previousContext) {
      promptTemplate = FOLLOWUP_EVALUATION_PROMPT;
    } else if (deepMode) {
      promptTemplate = DEEP_TECHNICAL_EVALUATION_PROMPT;
    } else if (interviewType === 'BEHAVIORAL') {
      promptTemplate = BEHAVIORAL_EVALUATION_PROMPT;
    } else {
      promptTemplate = TECHNICAL_EVALUATION_PROMPT;
    }

    let prompt = promptTemplate
      .replace('{question}', questionText)
      .replace('{answer}', correctedText);

    if (previousContext) {
      const contextLines = [
        `원래 질문: ${previousContext.originalQuestion}`,
        `원래 답변: ${previousContext.originalAnswer}`,
      ];
      for (const fh of previousContext.followUpHistory) {
        contextLines.push(`꼬리질문: ${fh.question}`);
        contextLines.push(`답변: ${fh.answer}`);
      }
      prompt = prompt.replace('{previousContext}', contextLines.join('\n'));
    }

    if (deepMode && !previousContext) {
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
