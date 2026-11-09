vi.mock('unzipper', () => ({ Open: { file: vi.fn() } }));

import * as unzipper from 'unzipper';

import { extractEpubContentEvidence } from './epub-content-evidence';

const openFile = (unzipper as any).Open.file as vi.Mock;

function zipFile(path: string, content: string, uncompressedSize = Buffer.byteLength(content)) {
  return { path, uncompressedSize, buffer: () => Promise.resolve(Buffer.from(content)) };
}

describe('extractEpubContentEvidence', () => {
  beforeEach(() => vi.resetAllMocks());

  it('extracts a bounded reading-order sample and flags likely title pages', async () => {
    const container = '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>';
    const opf = '<package><manifest><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="title"/><itemref idref="chapter"/></spine></package>';
    openFile.mockResolvedValue({
      files: [
        zipFile('META-INF/container.xml', container),
        zipFile('OPS/book.opf', opf),
        zipFile('OPS/title.xhtml', '<html><body><h1>Example Novel</h1><p>By Jane Author</p></body></html>'),
        zipFile('OPS/chapter.xhtml', '<html><body><script>ignored()</script><p>Chapter One: The Beginning</p></body></html>'),
      ],
    });

    await expect(extractEpubContentEvidence('/books/example.epub')).resolves.toEqual({
      documents: [
        expect.objectContaining({ path: 'OPS/title.xhtml', text: 'Example Novel By Jane Author', likelyTitlePage: true }),
        expect.objectContaining({ path: 'OPS/chapter.xhtml', text: 'Chapter One: The Beginning', likelyTitlePage: false }),
      ],
      truncated: false,
    });
  });

  it('rejects archives without a container document', async () => {
    openFile.mockResolvedValue({ files: [] });
    await expect(extractEpubContentEvidence('/books/broken.epub')).rejects.toThrow('EPUB container.xml is missing');
  });

  it('skips oversized XHTML documents instead of loading them into the verifier', async () => {
    const container = '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>';
    const opf = '<package><manifest><item id="large" href="large.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="large"/></spine></package>';
    openFile.mockResolvedValue({
      files: [zipFile('META-INF/container.xml', container), zipFile('book.opf', opf), zipFile('large.xhtml', '<html/>', 65 * 1024)],
    });

    await expect(extractEpubContentEvidence('/books/large.epub')).resolves.toEqual({ documents: [], truncated: true });
  });
});
