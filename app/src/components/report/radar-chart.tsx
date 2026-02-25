'use client';

import { RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer } from 'recharts';
import type { AnswerReport, EvaluationScores } from '@/types';

interface ScoreRadarChartProps {
  answers: AnswerReport[];
}

export function ScoreRadarChart({ answers }: ScoreRadarChartProps) {
  // Average scores across all answers
  const validAnswers = answers.filter(a => a.overallScore > 0);
  if (validAnswers.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">데이터가 부족합니다</p>;
  }

  const avgScores = {
    accuracy: 0,
    depth: 0,
    clarity: 0,
    completeness: 0,
    practicality: 0,
  };

  for (const answer of validAnswers) {
    const scores = answer.scores;
    avgScores.accuracy += scores.accuracy || 0;
    avgScores.depth += scores.depth || 0;
    avgScores.clarity += scores.clarity || 0;
    avgScores.completeness += scores.completeness || 0;
    avgScores.practicality += scores.practicality || 0;
  }

  const count = validAnswers.length;
  const chartData = [
    { subject: '기술 정확성', score: Math.round(avgScores.accuracy / count), fullMark: 100 },
    { subject: '이해 깊이', score: Math.round(avgScores.depth / count), fullMark: 100 },
    { subject: '전달 명확성', score: Math.round(avgScores.clarity / count), fullMark: 100 },
    { subject: '완성도', score: Math.round(avgScores.completeness / count), fullMark: 100 },
    { subject: '실무 적용력', score: Math.round(avgScores.practicality / count), fullMark: 100 },
  ];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <RadarChart cx="50%" cy="50%" outerRadius="80%" data={chartData}>
        <PolarGrid />
        <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12 }} />
        <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 10 }} />
        <Radar
          name="점수"
          dataKey="score"
          stroke="hsl(221.2, 83.2%, 53.3%)"
          fill="hsl(221.2, 83.2%, 53.3%)"
          fillOpacity={0.3}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}
