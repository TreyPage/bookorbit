import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AudiobookOpeningTranscriptionService, extractOpeningAudioSample } from './audiobook-opening-transcription.service';

describe('AudiobookOpeningTranscriptionService', () => {
  const config = {
    get: (key: string) => ({
      'contentVerification.sttBaseUrl': 'http://whisper:8000/v1',
      'contentVerification.sttModel': 'Systran/faster-whisper-small',
      'contentVerification.sttApiKey': undefined,
      'audioTools.ffmpegPath': 'ffmpeg',
    } as Record<string, string | undefined>)[key],
  } as unknown as ConfigService;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'Dune, by Frank Herbert.' }), { status: 200 })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects relative audiobook paths before invoking ffmpeg', async () => {
    await expect(extractOpeningAudioSample('relative/book.m4b')).rejects.toThrow('Audiobook path must be absolute');
  });

  it('requires an explicitly configured transcription endpoint', async () => {
    const disabled = new AudiobookOpeningTranscriptionService({ get: () => undefined } as unknown as ConfigService);
    await expect(disabled.transcribe('/books/dune.m4b')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
