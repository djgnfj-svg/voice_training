'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useRef } from 'react';
import { isAdmin } from '@/lib/admin';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';
import { normalizeTranscript } from '@/lib/transcript';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Mic, MicOff, Loader2, Play, Square } from 'lucide-react';

function TranscriptDisplay({ label, raw, normalized }: { label: string; raw: string; normalized?: string }) {
  if (!raw) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="rounded-md border bg-muted/50 p-3">
        <p className="text-sm whitespace-pre-wrap">{raw}</p>
      </div>
      {normalized && normalized !== raw && (
        <>
          <p className="text-sm font-medium text-muted-foreground">{label} (정규화 후)</p>
          <div className="rounded-md border bg-green-50 dark:bg-green-950/20 p-3">
            <p className="text-sm whitespace-pre-wrap">{normalized}</p>
          </div>
        </>
      )}
    </div>
  );
}

function WebSpeechPanel() {
  const { isListening, transcript, interimTranscript, isSupported, startListening, stopListening, resetTranscript } =
    useSpeechRecognition();

  if (!isSupported) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Web Speech API를 지원하지 않는 브라우저입니다.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Web Speech API
          <Badge variant={isListening ? 'default' : 'secondary'}>{isListening ? '녹음 중' : '대기'}</Badge>
        </CardTitle>
        <CardDescription>브라우저 내장 음성인식 (실시간)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          {isListening ? (
            <Button variant="destructive" onClick={stopListening}>
              <MicOff className="mr-2 h-4 w-4" />
              중지
            </Button>
          ) : (
            <Button onClick={startListening}>
              <Mic className="mr-2 h-4 w-4" />
              녹음 시작
            </Button>
          )}
          <Button variant="outline" onClick={resetTranscript} disabled={isListening}>
            초기화
          </Button>
        </div>

        {interimTranscript && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">실시간 (interim)</p>
            <div className="rounded-md border border-dashed bg-muted/30 p-3">
              <p className="text-sm italic text-muted-foreground">{interimTranscript}</p>
            </div>
          </div>
        )}

        <TranscriptDisplay label="최종 결과" raw={transcript} normalized={transcript ? normalizeTranscript(transcript) : undefined} />
      </CardContent>
    </Card>
  );
}

function WhisperPanel() {
  const { isRecording, isSupported, startRecording, stopRecording, resetRecording } = useAudioRecorder();
  const [whisperResult, setWhisperResult] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');

  const handleStop = useCallback(async () => {
    const blob = await stopRecording();
    if (!blob) {
      setError('녹음 데이터가 없습니다.');
      return;
    }

    setIsTranscribing(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('audio', blob, 'recording.webm');

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || '전사 실패');
        return;
      }

      setWhisperResult(data.transcript);
    } catch (e) {
      setError('요청 실패');
    } finally {
      setIsTranscribing(false);
    }
  }, [stopRecording]);

  const handleReset = useCallback(() => {
    resetRecording();
    setWhisperResult('');
    setError('');
  }, [resetRecording]);

  if (!isSupported) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          MediaRecorder를 지원하지 않는 브라우저입니다.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Whisper API
          <Badge variant={isRecording ? 'default' : 'secondary'}>{isRecording ? '녹음 중' : '대기'}</Badge>
        </CardTitle>
        <CardDescription>OpenAI Whisper (녹음 후 전사)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          {isRecording ? (
            <Button variant="destructive" onClick={handleStop} disabled={isTranscribing}>
              <MicOff className="mr-2 h-4 w-4" />
              녹음 중지 & 전사
            </Button>
          ) : (
            <Button onClick={() => startRecording()} disabled={isTranscribing}>
              <Mic className="mr-2 h-4 w-4" />
              녹음 시작
            </Button>
          )}
          <Button variant="outline" onClick={handleReset} disabled={isRecording || isTranscribing}>
            초기화
          </Button>
        </div>

        {isTranscribing && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Whisper로 전사 중...
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <TranscriptDisplay label="Whisper 결과" raw={whisperResult} normalized={whisperResult ? normalizeTranscript(whisperResult) : undefined} />
      </CardContent>
    </Card>
  );
}

function ComparePanel() {
  const { isListening, transcript, interimTranscript, isSupported: webSpeechSupported, startListening, stopListening, resetTranscript } =
    useSpeechRecognition();
  const { isRecording, isSupported: recorderSupported, startRecording, stopRecording, resetRecording } = useAudioRecorder();
  const [whisperResult, setWhisperResult] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');
  const isActive = isListening || isRecording;
  const isBothSupported = webSpeechSupported && recorderSupported;

  const handleStart = useCallback(() => {
    resetTranscript();
    setWhisperResult('');
    setError('');
    startListening();
    startRecording();
  }, [startListening, startRecording, resetTranscript]);

  const handleStop = useCallback(async () => {
    stopListening();
    const blob = await stopRecording();
    if (!blob) return;

    setIsTranscribing(true);
    try {
      const formData = new FormData();
      formData.append('audio', blob, 'recording.webm');
      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '전사 실패');
        return;
      }
      setWhisperResult(data.transcript);
    } catch {
      setError('Whisper 요청 실패');
    } finally {
      setIsTranscribing(false);
    }
  }, [stopListening, stopRecording]);

  const handleReset = useCallback(() => {
    resetTranscript();
    resetRecording();
    setWhisperResult('');
    setError('');
  }, [resetTranscript, resetRecording]);

  if (!isBothSupported) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          비교 모드를 사용하려면 Web Speech API와 MediaRecorder 모두 지원하는 브라우저가 필요합니다.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          비교 모드
          <Badge variant={isActive ? 'default' : 'secondary'}>{isActive ? '녹음 중' : '대기'}</Badge>
        </CardTitle>
        <CardDescription>Web Speech API와 Whisper를 동시에 녹음하여 결과 비교</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          {isActive ? (
            <Button variant="destructive" onClick={handleStop} disabled={isTranscribing}>
              <MicOff className="mr-2 h-4 w-4" />
              중지
            </Button>
          ) : (
            <Button onClick={handleStart} disabled={isTranscribing}>
              <Mic className="mr-2 h-4 w-4" />
              동시 녹음 시작
            </Button>
          )}
          <Button variant="outline" onClick={handleReset} disabled={isActive || isTranscribing}>
            초기화
          </Button>
        </div>

        {isTranscribing && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Whisper 전사 중...
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {interimTranscript && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">Web Speech (실시간)</p>
            <div className="rounded-md border border-dashed bg-muted/30 p-3">
              <p className="text-sm italic text-muted-foreground">{interimTranscript}</p>
            </div>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-sm font-semibold">Web Speech API</h4>
            <TranscriptDisplay label="원본" raw={transcript} normalized={transcript ? normalizeTranscript(transcript) : undefined} />
            {!transcript && !isActive && <p className="text-sm text-muted-foreground">결과 없음</p>}
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold">Whisper</h4>
            <TranscriptDisplay label="원본" raw={whisperResult} normalized={whisperResult ? normalizeTranscript(whisperResult) : undefined} />
            {!whisperResult && !isActive && !isTranscribing && <p className="text-sm text-muted-foreground">결과 없음</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const TTS_PERSONAS = [
  { value: 'default', label: '기본' },
  { value: 'interviewer', label: '면접관 (프로페셔널)' },
  { value: 'tutor', label: '튜터 (활기)' },
];
const TTS_MODELS = [
  { value: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (페르소나 지원, speed 약함)' },
  { value: 'tts-1', label: 'tts-1 (speed 정확, 페르소나 무시)' },
  { value: 'tts-1-hd', label: 'tts-1-hd (고품질, 느리고 비쌈)' },
];
const DEFAULT_TEXT = '안녕하세요. 오늘 기술 면접을 시작하겠습니다. 자기소개와 함께 가장 자신있는 프로젝트를 소개해주세요.';

function TTSTestPanel() {
  const [voice, setVoice] = useState('sage');
  const [persona, setPersona] = useState('default');
  const [speed, setSpeed] = useState(1.1);
  const [model, setModel] = useState('gpt-4o-mini-tts');
  const [text, setText] = useState(DEFAULT_TEXT);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const handlePlay = async () => {
    stop();
    setError('');
    setIsLoading(true);
    setElapsed(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, persona, speed, model }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setElapsed(Math.round(performance.now() - t0));

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplay = () => setIsPlaying(true);
      audio.onended = () => {
        setIsPlaying(false);
        URL.revokeObjectURL(url);
        urlRef.current = null;
      };
      audio.onerror = () => {
        setError('오디오 재생 실패');
        setIsPlaying(false);
      };
      await audio.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청 실패');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>TTS 발화 테스트</CardTitle>
        <CardDescription>보이스 / 페르소나 / 속도 조합으로 OpenAI gpt-4o-mini-tts 품질 확인</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>모델</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TTS_MODELS.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label>보이스</Label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TTS_VOICES.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>페르소나</Label>
            <Select value={persona} onValueChange={setPersona}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TTS_PERSONAS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>속도: {speed.toFixed(2)}x</Label>
            <input
              type="range"
              min="0.25"
              max="4.0"
              step="0.05"
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              className="w-full"
            />
            {model === 'gpt-4o-mini-tts' && speed !== 1.0 && (
              <p className="text-xs text-amber-600">⚠️ gpt-4o-mini-tts는 speed 파라미터를 거의 무시해요. 빠르게 원하면 모델을 tts-1로 바꾸세요.</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>문장</Label>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="읽어볼 문장을 입력하세요"
          />
        </div>

        <div className="flex items-center gap-2">
          {isPlaying ? (
            <Button variant="destructive" onClick={stop}>
              <Square className="mr-2 h-4 w-4" />
              정지
            </Button>
          ) : (
            <Button onClick={handlePlay} disabled={isLoading || !text.trim()}>
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {isLoading ? '생성 중...' : '재생'}
            </Button>
          )}
          {elapsed !== null && (
            <Badge variant="secondary">생성 {elapsed}ms</Badge>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
          <p>💡 마음에 드는 조합을 찾으면 기본값으로 설정 가능 (tts/main.py 의 <code>TTS_DEFAULT_VOICE</code>, <code>TTS_SPEED</code>).</p>
          <p>💡 페르소나는 gpt-4o-mini-tts의 <code>instructions</code>로 톤을 지시 — 같은 보이스도 다르게 들림.</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function VoiceTestPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;
    if (!isAdmin(session?.user?.email)) {
      router.replace('/dashboard');
    }
  }, [session, status, router]);

  if (status === 'loading' || !isAdmin(session?.user?.email)) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">음성 테스트</h1>
        <p className="text-muted-foreground">STT(음성인식) + TTS(발화) 품질 테스트</p>
      </div>

      <Tabs defaultValue="tts">
        <TabsList>
          <TabsTrigger value="tts">TTS 발화</TabsTrigger>
          <TabsTrigger value="webspeech">Web Speech API</TabsTrigger>
          <TabsTrigger value="whisper">Whisper</TabsTrigger>
          <TabsTrigger value="compare">비교 모드</TabsTrigger>
        </TabsList>
        <TabsContent value="tts" className="mt-4">
          <TTSTestPanel />
        </TabsContent>
        <TabsContent value="webspeech" className="mt-4">
          <WebSpeechPanel />
        </TabsContent>
        <TabsContent value="whisper" className="mt-4">
          <WhisperPanel />
        </TabsContent>
        <TabsContent value="compare" className="mt-4">
          <ComparePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
