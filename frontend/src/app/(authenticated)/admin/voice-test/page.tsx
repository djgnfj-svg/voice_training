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
import { Mic, MicOff, Loader2 } from 'lucide-react';

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
        <h1 className="text-2xl font-bold">음성인식 테스트</h1>
        <p className="text-muted-foreground">Web Speech API와 Whisper의 음성인식 품질을 테스트합니다.</p>
      </div>

      <Tabs defaultValue="webspeech">
        <TabsList>
          <TabsTrigger value="webspeech">Web Speech API</TabsTrigger>
          <TabsTrigger value="whisper">Whisper</TabsTrigger>
          <TabsTrigger value="compare">비교 모드</TabsTrigger>
        </TabsList>
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
