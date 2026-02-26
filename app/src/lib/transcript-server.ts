import { openai, MODELS } from '@/lib/openai';

export interface TranscriptCorrection {
  correctedText: string;
  wasChanged: boolean;
}

export async function correctTranscript(rawTranscript: string): Promise<TranscriptCorrection> {
  if (rawTranscript.length < 10) {
    return { correctedText: rawTranscript, wasChanged: false };
  }

  try {
    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [
        {
          role: 'user',
          content: `다음 한국어 음성 인식 텍스트를 교정해주세요. 규칙:
1. 띄어쓰기를 올바르게 수정
2. 기술 용어를 정확한 표기로 수정 (예: "리엑트"→"리액트", "에이피아이"→"API", "제이에스"→"JS", "타입스크립트"→"TypeScript")
3. 문장 부호를 적절히 추가
4. 의미를 변경하지 말 것

원본과 동일하면 그대로 반환하세요.
교정된 텍스트만 반환하세요. 설명 없이.

텍스트: ${rawTranscript}`,
        },
      ],
      temperature: 0,
    });

    const correctedText = response.choices[0]?.message?.content?.trim();
    if (!correctedText) {
      return { correctedText: rawTranscript, wasChanged: false };
    }

    const wasChanged = correctedText !== rawTranscript;
    return { correctedText, wasChanged };
  } catch (error) {
    console.error('Transcript correction failed:', error);
    return { correctedText: rawTranscript, wasChanged: false };
  }
}
