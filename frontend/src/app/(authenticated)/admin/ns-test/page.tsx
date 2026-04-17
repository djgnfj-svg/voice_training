'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';

type Hit = {
  id: string;
  category: string;
  content: string;
  similarity: number;
};

type EmbRow = {
  id: string;
  category: string;
  content: string;
  createdAt: string | null;
};

type SeedNode = {
  title: string;
  description: string;
  depth_level: number;
  parent_title: string | null;
  keywords: string[];
};

const CATEGORIES = ['misconception', 'explanation', 'connection', 'question'] as const;

export default function NsTestPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">NS 테스트</h1>
        <p className="text-sm text-muted-foreground mt-1">
          CS 학습 어시스트 — RAG 검색/저장, 시드 프리뷰
        </p>
      </div>

      <InsertCard />
      <SearchCard />
      <MyEmbeddingsCard />
      <SeedPreviewCard />
    </div>
  );
}

function InsertCard() {
  const [category, setCategory] = useState<typeof CATEGORIES[number]>('explanation');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    if (!content.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/ns-test/insert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      setResult(`저장됨: ${data.id}`);
      setContent('');
    } catch (e) {
      setResult(`실패: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">1. 임베딩 저장</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          {CATEGORIES.map((c) => (
            <Button
              key={c}
              variant={category === c ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCategory(c)}
            >
              {c}
            </Button>
          ))}
        </div>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="내용 입력 (예: '유저가 이벤트 루프에서 콜스택과 태스크 큐를 헷갈려함')"
          rows={3}
        />
        <Button onClick={submit} disabled={loading || !content.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '저장'}
        </Button>
        {result && (
          <p className="text-xs text-muted-foreground break-all">{result}</p>
        )}
      </CardContent>
    </Card>
  );
}

function SearchCard() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);

  const submit = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setHits(null);
    try {
      const res = await fetch('/api/admin/ns-test/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, category: category || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      setHits(data.hits);
    } catch (e) {
      setHits([]);
      alert(`실패: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">2. 임베딩 검색</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={category === '' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setCategory('')}
          >
            전체
          </Button>
          {CATEGORIES.map((c) => (
            <Button
              key={c}
              variant={category === c ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCategory(c)}
            >
              {c}
            </Button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="검색 쿼리 (예: '이벤트 루프')"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <Button onClick={submit} disabled={loading || !query.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '검색'}
        </Button>
        {hits !== null && (
          <div className="space-y-2 pt-2">
            {hits.length === 0 ? (
              <p className="text-sm text-muted-foreground">결과 없음</p>
            ) : (
              hits.map((h) => (
                <div key={h.id} className="border rounded-md p-3 text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{h.category}</Badge>
                    <span className="text-xs text-muted-foreground">
                      sim: {h.similarity.toFixed(4)}
                    </span>
                  </div>
                  <p>{h.content}</p>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MyEmbeddingsCard() {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<EmbRow[] | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/ns-test/my-embeddings');
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      setRows(data.rows);
    } catch (e) {
      alert(`실패: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">3. 내 임베딩 목록 (최신 20)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={load} disabled={loading} variant="outline">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '불러오기'}
        </Button>
        {rows !== null && (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">저장된 임베딩 없음</p>
            ) : (
              rows.map((r) => (
                <div key={r.id} className="border rounded-md p-3 text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{r.category}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {r.createdAt ? new Date(r.createdAt).toLocaleString('ko-KR') : ''}
                    </span>
                  </div>
                  <p>{r.content}</p>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SeedPreviewCard() {
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<SeedNode[] | null>(null);
  const [raw, setRaw] = useState<string>('');

  const submit = async () => {
    if (!title.trim()) return;
    setLoading(true);
    setNodes(null);
    setRaw('');
    try {
      const res = await fetch('/api/admin/ns-test/seed-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(data));
      const arr = data.data?.nodes;
      if (Array.isArray(arr)) {
        setNodes(arr);
      } else {
        setRaw(JSON.stringify(data.data, null, 2));
      }
    } catch (e) {
      alert(`실패: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">4. 시드 커리큘럼 프리뷰</CardTitle>
        <p className="text-xs text-muted-foreground">
          DB 저장 없이 LLM만 돌려서 JSON 결과를 본다.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="목표 (예: 백엔드 엔지니어, AI Agent 엔지니어)"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <Button onClick={submit} disabled={loading || !title.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '생성'}
        </Button>
        {nodes && (
          <div className="space-y-2 pt-2">
            <p className="text-xs text-muted-foreground">{nodes.length}개 노드</p>
            {nodes.map((n, i) => (
              <div key={i} className="border rounded-md p-3 text-sm space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge>{n.title}</Badge>
                  <Badge variant="outline">depth {n.depth_level}</Badge>
                  {n.parent_title ? (
                    <Badge variant="secondary">↳ {n.parent_title}</Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{n.description}</p>
                <p className="text-xs">{n.keywords.join(', ')}</p>
              </div>
            ))}
          </div>
        )}
        {raw && (
          <pre className="text-xs bg-muted p-3 rounded overflow-x-auto max-h-96">
            {raw}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
