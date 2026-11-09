import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AudiobookOpeningTranscriptionService } from './audiobook-opening-transcription.service';

describe('AudiobookOpeningTranscriptionService', () => {
  const config = {
    get: (key: string) => ({
      'contentVerification.sttBaseUrl': 'http://whisper:8000/v1',
      'contentVerification.sttModel': 'Systran/faster-whisper-small',
      'contentVerification.sttApiKey': undefined,
      'audioTools.ffmpegPath': 'ffmpeg',
    } as Record<string, string | undefined>)[key],
  } as unknown as ConfigService;
  let service: AudiobookOpeningTranscriptionService;

  beforeEach(() => {
    service = new AudiobookOpeningTranscriptionService(config);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'Dune, by Frank Herbert.' }), { status: 200 })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('requires an explicitly configured transcription endpoint', async () => {
    const disabled = new AudiobookOpeningTranscriptionService({ get: () => undefined } as unknown as ConfigService);
    await expect(disabled.transcribe('/books/dune.m4b')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
