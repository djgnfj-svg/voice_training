import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { uploadFile } from '@/lib/minio';
import { RESUME_PARSING_PROMPT } from '@/prompts/resume';
import type { ParsedResume } from '@/types';

export class ResumeService {
  async uploadAndParse(userId: string, file: Buffer, filename: string): Promise<ParsedResume> {
    // Upload to MinIO
    const key = `resumes/${userId}/${Date.now()}_${filename}`;
    const url = await uploadFile(key, file, 'application/pdf');

    // Extract text from PDF
    const pdfParse = (await import('pdf-parse')).default;
    const pdfData = await pdfParse(file);
    const text = pdfData.text;

    // Parse with GPT
    const parsedResume = await this.parseResume(text);

    // Update user record
    await prisma.user.update({
      where: { id: userId },
      data: {
        resumeUrl: url,
        parsedResume: parsedResume as any,
      },
    });

    return parsedResume;
  }

  private async parseResume(text: string): Promise<ParsedResume> {
    const prompt = RESUME_PARSING_PROMPT.replace('{resumeText}', text);

    const response = await openai.chat.completions.create({
      model: MODELS.ANALYSIS,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Failed to parse resume');

    return JSON.parse(content) as ParsedResume;
  }

  async getUserResume(userId: string): Promise<ParsedResume | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { parsedResume: true },
    });
    return (user?.parsedResume as unknown as ParsedResume) || null;
  }
}

export const resumeService = new ResumeService();
