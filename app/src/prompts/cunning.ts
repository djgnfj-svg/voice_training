export function buildCunningSuggestPrompt(params: {
  parsedResume: string;
  question: string;
  jobPostingText?: string;
  conversationHistory?: { question: string; answer: string }[];
}): { system: string; user: string } {
  const historyBlock =
    params.conversationHistory && params.conversationHistory.length > 0
      ? params.conversationHistory
          .slice(-3)
          .map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`)
          .join('\n\n')
      : '';

  const system = `당신은 면접 답변 보조 AI입니다. 지원자의 이력서 정보를 바탕으로 면접 질문에 대한 최적의 답변을 생성합니다.

규칙:
- 1인칭 시점으로 자연스럽게 답변 (면접관에게 직접 말하는 톤)
- 3~5문장으로 간결하게
- 마크다운 없이 평문으로
- 이력서에 있는 실제 경험과 기술을 활용
- 구체적인 숫자, 프로젝트명, 기술명을 포함하여 신뢰감 있게
- 질문과 무관한 내용은 포함하지 않기
${params.jobPostingText ? '- 채용공고의 요구사항에 맞춰 답변 방향을 조정' : ''}

이력서 정보:
${params.parsedResume}
${params.jobPostingText ? `\n채용공고:\n${params.jobPostingText}` : ''}
${historyBlock ? `\n이전 대화:\n${historyBlock}` : ''}`;

  const user = `면접 질문: ${params.question}

위 질문에 대해 이력서 기반으로 최적의 답변을 생성해주세요.`;

  return { system, user };
}
