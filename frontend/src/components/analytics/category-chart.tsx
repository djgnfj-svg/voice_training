'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { CategoryPerformance } from '@/types';

interface CategoryChartProps {
  data: CategoryPerformance[];
}

const categoryLabels: Record<string, string> = {
  job_posting: '공고 맞춤',
  resume_based: '이력서 기반',
  general: '일반',
};

export function CategoryChart({ data }: CategoryChartProps) {
  const chartData = data.map(d => ({
    ...d,
    name: categoryLabels[d.category] || d.category,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
        <Tooltip
          formatter={(value: number) => [`${value}점`, '평균 점수']}
        />
        <Bar
          dataKey="averageScore"
          fill="hsl(221.2, 83.2%, 53.3%)"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
