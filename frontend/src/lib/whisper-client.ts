const MAX_AUDIO_SIZE = 4.5 * 1024 * 1024; // 4.5MB

export async function transcribeWithWhisper(audioBlob: Blob): Promise<string | null> {
  if (audioBlob.size > MAX_AUDIO_SIZE) return null;
  try {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!res.ok) return null;
    const data = await res.json();
    return data.transcript || null;
  } catch {
    return null;
  }
}
