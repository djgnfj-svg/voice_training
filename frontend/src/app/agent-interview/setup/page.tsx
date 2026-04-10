"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useQuery } from "@tanstack/react-query";

export default function AgentInterviewSetupPage() {
  const router = useRouter();
  const [resumeId, setResumeId] = useState("");
  const [maxQuestions, setMaxQuestions] = useState("7");
  const [textMode, setTextMode] = useState(false);

  const { data: resumes } = useQuery({
    queryKey: ["resumes"],
    queryFn: async () => {
      const res = await fetch("/api/resume", { credentials: "include" });
      if (!res.ok) throw new Error("이력서 목록을 불러올 수 없습니다");
      return res.json();
    },
  });

  const handleStart = () => {
    if (!resumeId) return;
    const params = new URLSearchParams({
      resumeId,
      maxQuestions,
      textMode: String(textMode),
    });
    router.push(`/agent-interview/session/new?${params}`);
  };

  return (
    <div className="container max-w-2xl py-8">
      <Card>
        <CardHeader>
          <CardTitle>AI 코치 면접</CardTitle>
          <CardDescription>
            AI가 당신을 기억하고, 맞춤형 면접을 진행합니다
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>이력서 선택 (필수)</Label>
            <Select value={resumeId} onValueChange={setResumeId}>
              <SelectTrigger>
                <SelectValue placeholder="이력서를 선택하세요" />
              </SelectTrigger>
              <SelectContent>
                {resumes?.map((r: { id: string; name: string }) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>질문 수</Label>
            <Select value={maxQuestions} onValueChange={setMaxQuestions}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[3, 5, 7, 10].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}개
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>텍스트 모드</Label>
            <Switch checked={textMode} onCheckedChange={setTextMode} />
          </div>

          <Button
            className="w-full"
            disabled={!resumeId}
            onClick={handleStart}
          >
            면접 시작
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
