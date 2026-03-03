import { tavily, TavilyClient } from '@tavily/core';

export interface CompanySearchResult {
  query: string;
  answer?: string;
  results: { title: string; url: string; content: string }[];
}

const globalForTavily = globalThis as unknown as {
  tavilyClient: TavilyClient | undefined;
};

export const isTavilyAvailable = !!process.env.TAVILY_API_KEY;

function getClient(): TavilyClient | null {
  if (!process.env.TAVILY_API_KEY) return null;

  if (!globalForTavily.tavilyClient) {
    globalForTavily.tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });
  }
  return globalForTavily.tavilyClient;
}

export async function searchCompanyInfo(
  company: string,
  position: string,
): Promise<CompanySearchResult[] | null> {
  const client = getClient();
  if (!client) return null;

  const queries = [
    `${company} ${position} 면접 후기 채용 기출문제`,
    `${company} interview ${position} company culture products`,
  ];

  try {
    const results = await Promise.allSettled(
      queries.map(async (query): Promise<CompanySearchResult> => {
        const response = await client.search(query, {
          searchDepth: 'basic',
          maxResults: 5,
          includeAnswer: true,
        });
        return {
          query,
          answer: response.answer,
          results: response.results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
          })),
        };
      }),
    );

    const successful: CompanySearchResult[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') successful.push(r.value);
    }

    return successful.length > 0 ? successful : null;
  } catch {
    return null;
  }
}
