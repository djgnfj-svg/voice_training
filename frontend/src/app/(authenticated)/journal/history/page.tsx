"use client";

import { useQuery } from "@tanstack/react-query";
import { getJournalHistory } from "@/lib/journal-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function JournalHistoryPage() {
  const { data: sessions, isLoading } = useQuery({
    queryKey: ["journal-history"],
    queryFn: getJournalHistory,
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const sessionsWithSummary = (sessions || []).filter(
    (s) => s.summary,
  );

  if (sessionsWithSummary.length === 0) {
    return (
      <div className="p-6">
        <h1 className="mb-6 text-2xl font-bold">하루의 기록</h1>
        <p className="text-muted-foreground">아직 기록이 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold">하루의 기록</h1>
      <div className="space-y-4">
        {sessionsWithSummary.map((session) => (
          <Card key={session.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  {new Date(session.createdAt).toLocaleDateString("ko-KR", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    weekday: "short",
                  })}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {session.messageCount}개 메시지
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {session.summary}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
