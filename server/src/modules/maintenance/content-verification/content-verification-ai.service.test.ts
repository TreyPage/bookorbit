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
