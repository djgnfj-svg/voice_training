import { Prisma } from '@prisma/client';
import { openai, MODELS } from '@/lib/openai';
import { prisma } from '@/lib/prisma';
import { RESUME_PARSING_PROMPT } from '@/prompts/resume';
import type { ParsedResume } from '@/types';

export class ResumeService {
  async uploadAndParse(
    userId: string,
    file: Buffer,
    filename: string,
    name: string
  ) {
    // Extract text from PDF
    const pdfParse = (await import('pdf-parse')).default;
    const pdfData = await pdfParse(file);
    const text = pdfData.text;

    // Parse with Claude
    const parsedResume = await this.parseResume(text);

    // Create Resume record
    const resume = await prisma.resume.create({
      data: {
        userId,
        name,
        parsedData: parsedResume as unknown as Prisma.InputJsonValue,
      },
    });

    return resume;
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

  async getUserResumes(userId: string) {
    return prisma.resume.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        parsedData: true,
        createdAt: true,
      },
    });
  }

  async getResumeById(id: string, userId: string) {
    return prisma.resume.findFirst({
      where: { id, userId },
    });
  }

  async deleteResume(id: string, userId: string) {
    const resume = await prisma.resume.findFirst({
      where: { id, userId },
    });
    if (!resume) throw new Error('Resume not found');

    await prisma.resume.delete({ where: { id } });
    return resume;
  }

  async renameResume(id: string, userId: string, name: string) {
    const resume = await prisma.resume.findFirst({
      where: { id, userId },
    });
    if (!resume) throw new Error('Resume not found');

    return prisma.resume.update({
      where: { id },
      data: { name },
    });
  }
}

export const resumeService = new ResumeService();
