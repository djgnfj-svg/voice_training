"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SessionSummaryCardProps {
  summary: {
    summary: string;
    mood: string;
    highlights: string[];
  };
  date?: string;
}

export function SessionSummaryCard({ summary, date }: SessionSummaryCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">오늘의 기록</CardTitle>
          {date && (
            <span className="text-sm text-muted-foreground">{date}</span>
          )}
        </div>
        <div className="inline-flex w-fit items-center rounded-full bg-muted px-2.5 py-0.5 text-xs">
          기분: {summary.mood}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed">{summary.summary}</p>
        {summary.highlights.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">하이라이트</p>
            <ul className="space-y-1">
              {summary.highlights.map((h, i) => (
                <li key={i} className="text-sm text-muted-foreground">
                  &bull; {h}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
