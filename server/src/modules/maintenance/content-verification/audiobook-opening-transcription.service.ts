import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const OPENING_SAMPLE_SECONDS = 30;
const MAX_AUDIO_SAMPLE_BYTES = 16 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 60_000;

export interface OpeningAudioTranscript {
  transcript: string;
  sampleSeconds: number;
  model: string;
}

/** Extracts only the opening 30 seconds; ffmpeg receives the path as an argument, never via a shell. */
export function extractOpeningAudioSample(absolutePath: string, ffmpegPath = 'ffmpeg'): Promise<Buffer> {
  if (!isAbsolute(absolutePath)) return Promise.reject(new Error('Audiobook path must be absolute'));

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', absolutePath,
      '-t', String(OPENING_SAMPLE_SECONDS),
      '-vn', '-ac', '1', '-ar', '16000',
      '-f', 'mp3', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('Opening audio extraction timed out')));
    }, FFMPEG_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_AUDIO_SAMPLE_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('Opening audio sample exceeded the size limit')));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf-8').slice(0, 2000 - stderr.length);
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`ffmpeg could not extract the opening audio sample: ${stderr.slice(0, 300)}`));
          return;
        }
        const audio = Buffer.concat(chunks);
        if (audio.length === 0) {
          reject(new Error('Audiobook opening sample was empty'));
          return;
        }
        resolve(audio);
      });
    });
  });
}

@Injectable()
export class AudiobookOpeningTranscriptionService {
  constructor(private readonly config: ConfigService) {}

  async transcribe(absolutePath: string): Promise<OpeningAudioTranscript> {
    const baseUrl = this.config.get<string>('contentVerification.sttBaseUrl')?.replace(/\/$/, '');
    const model = this.config.get<string>('contentVerification.sttModel') || 'Systran/faster-whisper-small';
    const apiKey = this.config.get<string>('contentVerification.sttApiKey');
    if (!baseUrl) throw new ServiceUnavailableException('Audiobook transcription provider is not configured');

    const ffmpegPath = this.config.get<string>('audioTools.ffmpegPath') || 'ffmpeg';
    const audio = await extractOpeningAudioSample(absolutePath, ffmpegPath);
    const form = new FormData();
    form.set('model', model);
    form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'opening.mp3');

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException(`Audiobook transcription failed (HTTP ${response.status})`);
    }
    const result = (await response.json()) as { text?: unknown };
    if (typeof result.text !== 'string' || !result.text.trim()) {
      throw new ServiceUnavailableException('Audiobook transcription provider returned no speech');
    }
    return { transcript: result.text.trim().slice(0, 12_000), sampleSeconds: OPENING_SAMPLE_SECONDS, model };
  }
}
