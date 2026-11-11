import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ContentVerificationAiService } from './content-verification-ai.service';

describe('ContentVerificationAiService', () => {
  const config = {
    get: vi.fn(
      (key: string) =>
        (
          ({
            'contentVerification.aiBaseUrl': 'http://ollama:11434/v1',
            'contentVerification.aiModel': 'qwen3.5:4b',
            'contentVerification.aiApiKey': undefined,
            'contentVerification.aiTimeoutMs': 180_000,
          }) as Record<string, string | undefined>
        )[key],
    ),
  } as unknown as ConfigService;
  let service: ContentVerificationAiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ContentVerificationAiService(config);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends bounded evidence to an OpenAI-compatible endpoint and parses a match', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: 'match',
                  detectedTitle: 'Dune',
                  detectedAuthor: 'Frank Herbert',
                  confidence: 0.98,
                  evidence: 'Dune by Frank Herbert',
                  explanation: 'The title page matches.',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(
      service.compare({
        expectedTitle: 'Dune',
        expectedAuthors: ['Frank Herbert'],
        source: 'ebook',
        evidence: [{ label: 'title.xhtml', text: 'Dune by Frank Herbert' }],
      }),
    ).resolves.toMatchObject({ status: 'match', confidence: 0.98 });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.body).toEqual(expect.stringContaining('Dune by Frank Herbert'));
    expect(request.body).toEqual(expect.stringContaining('qwen3.5:4b'));
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(180_000);
    timeoutSpy.mockRestore();
  });

  it('overrides a model match when the extracted title and author contradict the expected identity', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                status: 'match',
                detectedTitle: 'An End to All Tales',
                detectedAuthor: 'Andrew Cyple',
                confidence: 0.98,
                evidence: 'An End to All Tales by Andrew Cyple',
                explanation: 'The series name matches.',
              }),
            },
          }],
        }),
        { status: 200 },
      ),
    );

    await expect(service.compare({
      expectedTitle: 'An End to All Tails',
      expectedAuthors: ['Andrew Seiple'],
      source: 'ebook',
      evidence: [{ label: 'title page', text: 'An End to All Tales by Andrew Cyple' }],
    })).resolves.toMatchObject({
      status: 'mismatch',
      explanation: expect.stringContaining('Bibliographic identity mismatch'),
    });
  });

  it('does not treat a shared series label as a substitute for the expected book title', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                status: 'match',
                detectedTitle: 'Air of Novron',
                detectedAuthor: 'Michael J. Sullivan',
                confidence: 0.98,
                evidence: 'Air of Novron by Michael J. Sullivan',
                explanation: 'The series name matches.',
              }),
            },
          }],
        }),
        { status: 200 },
      ),
    );

    await expect(service.compare({
      expectedTitle: 'Heir of Novron',
      expectedAuthors: ['Michael J. Sullivan'],
      source: 'audiobook',
      evidence: [{ label: 'opening audio', text: 'Air of Novron by Michael J. Sullivan' }],
    })).resolves.toMatchObject({ status: 'mismatch' });
  });

  it('rejects malformed or out-of-range model confidence', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ status: 'match', confidence: 1.5 }) } }],
        }),
        { status: 200 },
      ),
    );

    await expect(
      service.compare({
        expectedTitle: 'Dune',
        expectedAuthors: [],
        source: 'ebook',
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails clearly when the provider is not configured', async () => {
    const disabled = new ContentVerificationAiService({
      get: () => undefined,
    } as unknown as ConfigService);

    await expect(
      disabled.compare({
        expectedTitle: 'Dune',
        expectedAuthors: [],
        source: 'ebook',
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
