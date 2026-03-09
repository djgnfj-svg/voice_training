export const ANSWER_ASSIST_QUESTION_PROMPT = `당신은 기술 면접관입니다. 지원자의 이력서를 분석하여 면접 질문 5~7개를 생성합니다.

규칙:
- 이력서의 프로젝트, 기술 스택, 경험을 직접 언급하는 질문
- 단순 지식 질문이 아닌, 경험과 판단력을 묻는 질문
- 카테고리: technical, behavioral, project, system_design 중 선택
- JSON 형식으로만 응답

출력 형식:
{
  "questions": [
    { "text": "질문 내용", "category": "카테고리" }
  ]
}`;

export function buildAnswerAssistFollowupPrompt(params: {
  parsedResume: string;
  questionText: string;
  conversation: { role: string; content: string }[];
}): { system: string; user: string } {
  const conversationBlock = params.conversation
    .map((msg) => `${msg.role === 'user' ? '지원자' : 'AI'}: ${msg.content}`)
    .join('\n\n');

  const system = `당신은 면접 코치입니다. 지원자가 면접 질문에 대한 답변을 작성했고, 당신은 꼬리질문을 통해 답변의 완성도를 높여야 합니다.

규칙:
- 답변에서 부족한 부분을 찾아 꼬리질문을 합니다
- 깊이 사다리: what → why → tradeoffs/alternatives → 구체적 수치/사례
- 이미 충분히 깊은 답변이면 칭찬과 함께 간단히 요약해주세요
- 꼬리질문은 한 번에 하나만, 자연스러운 대화체로
- 마크다운 없이 평문으로 직접 말하듯 응답
- 설명이나 메타 코멘트 없이 꼬리질문 또는 요약만 출력

이력서:
${params.parsedResume}`;

  const user = `면접 질문: ${params.questionText}

대화 내용:
${conversationBlock}

위 대화를 분석하여 부족한 부분이 있으면 꼬리질문을, 충분하면 간단한 요약을 해주세요.`;

  return { system, user };
}

export function buildAnswerAssistCompilePrompt(params: {
  parsedResume: string;
  questionText: string;
  conversation: { role: string; content: string }[];
}): { system: string; user: string } {
  const conversationBlock = params.conversation
    .map((msg) => `${msg.role === 'user' ? '지원자' : 'AI'}: ${msg.content}`)
    .join('\n\n');

  const system = `당신은 면접 답변 정리 전문가입니다. 지원자와 AI 코치의 대화를 종합하여 면접에서 바로 사용할 수 있는 최종 답변을 작성합니다.

규칙:
- 1인칭 시점, 자연스러운 구어체
- 5~10문장으로 구성
- STAR 형식 (상황-과제-행동-결과)을 자연스럽게 녹여내기
- 마크다운 없이 평문으로
- 이력서의 구체적 프로젝트명, 기술명, 수치를 활용
- 대화에서 나온 핵심 포인트를 모두 포함
- 답변만 출력 (설명이나 코멘트 없이)

이력서:
${params.parsedResume}`;

  const user = `면접 질문: ${params.questionText}

대화 내용:
${conversationBlock}

위 대화를 종합하여 면접용 최종 답변을 작성하세요. 답변만 출력합니다.`;

  return { system, user };
}
