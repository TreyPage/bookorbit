import { ServiceUnavailableException } from '@nestjs/common';

import { AudiobookOpeningTranscriptionService, extractOpeningAudioSample } from './audiobook-opening-transcription.service';

describe('AudiobookOpeningTranscriptionService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'Dune, by Frank Herbert.' }), { status: 200 })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects relative audiobook paths before invoking ffmpeg', async () => {
    await expect(extractOpeningAudioSample('relative/book.m4b')).rejects.toThrow('Audiobook path must be absolute');
  });

  it('requires an explicitly configured transcription endpoint', async () => {
    const disabled = new AudiobookOpeningTranscriptionService({ get: () => undefined } as never);
    await expect(disabled.transcribe('/books/dune.m4b')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
