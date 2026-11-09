import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';
import * as unzipper from 'unzipper';

import { findInZip, resolvePath, toRecordArray } from '../../metadata/lib/epub-zip-utils';

const MAX_DOCUMENTS = 8;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_CHARS = 30_000;
const MAX_DOCUMENT_TEXT_CHARS = 10_000;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  parseTagValue: false,
});

export interface EpubContentEvidence {
  path: string;
  text: string;
  likelyTitlePage: boolean;
}

export interface EpubContentInspection {
  documents: EpubContentEvidence[];
  truncated: boolean;
}

/**
 * Extracts a small, bounded sample of the EPUB reading order for content verification.
 * This deliberately does not return the whole book: only the first few XHTML spine
 * documents are inspected, with strict per-document and aggregate limits.
 */
export async function extractEpubContentEvidence(absolutePath: string): Promise<EpubContentInspection> {
  const zip = await unzipper.Open.file(absolutePath);
  const containerFile = zip.files.find((file) => file.path.replace(/^\//, '') === 'META-INF/container.xml');
  if (!containerFile) throw new Error('EPUB container.xml is missing');

  const containerXml = (await containerFile.buffer()).toString('utf-8');
  const container = xmlParser.parse(containerXml) as Record<string, unknown>;
  const containerNode = container['container'] as Record<string, unknown> | undefined;
  const rootfiles = (containerNode?.['rootfiles'] as Record<string, unknown> | undefined)?.['rootfile'];
  const rootfile = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const opfPath = (rootfile as Record<string, unknown> | undefined)?.['@_full-path'];
  if (typeof opfPath !== 'string' || !opfPath.trim()) throw new Error('EPUB package document path is missing');

  const opfFile = zip.files.find((file) => file.path.replace(/^\//, '') === opfPath.replace(/^\//, ''));
  if (!opfFile) throw new Error('EPUB package document is missing');
  const opf = xmlParser.parse((await opfFile.buffer()).toString('utf-8')) as Record<string, unknown>;
  const packageNode = (opf['package'] ?? opf['opf:package']) as Record<string, unknown> | undefined;
  const manifest = packageNode?.['manifest'] as Record<string, unknown> | undefined;
  const spine = packageNode?.['spine'] as Record<string, unknown> | undefined;
  if (!manifest || !spine) throw new Error('EPUB package document has no manifest or spine');

  const manifestItems = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of toRecordArray(manifest['item'])) {
    const id = item['@_id'];
    const href = item['@_href'];
    const mediaType = item['@_media-type'];
    if (typeof id === 'string' && typeof href === 'string' && typeof mediaType === 'string') {
      manifestItems.set(id, {
        href,
        mediaType,
        properties: typeof item['@_properties'] === 'string' ? item['@_properties'] : '',
      });
    }
  }

  const opfDirectory = opfPath.slice(0, Math.max(0, opfPath.lastIndexOf('/') + 1));
  const itemRefs = toRecordArray(spine['itemref']);
  const documents: EpubContentEvidence[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const itemRef of itemRefs) {
    if (documents.length >= MAX_DOCUMENTS || totalChars >= MAX_TOTAL_TEXT_CHARS) {
      truncated = true;
      break;
    }
    const idref = itemRef['@_idref'];
    if (typeof idref !== 'string') continue;
    const item = manifestItems.get(idref);
    if (!item || !['application/xhtml+xml', 'text/html'].includes(item.mediaType.toLowerCase())) continue;

    const file = findInZip(zip, item.href, opfDirectory);
    if (!file) continue;
    if (file.uncompressedSize > MAX_DOCUMENT_BYTES) {
      truncated = true;
      continue;
    }

    const html = (await file.buffer()).toString('utf-8');
    const $ = load(html);
    $('script, style, noscript, svg, nav, audio, video').remove();
    const rawText = $('body').text() || $.root().text();
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, Math.min(MAX_DOCUMENT_TEXT_CHARS, MAX_TOTAL_TEXT_CHARS - totalChars));
    if (!text) continue;

    totalChars += text.length;
    documents.push({
      path: file.path,
      text,
      likelyTitlePage: /title|cover|frontmatter|copyright|half.?title/i.test(file.path) ||
        /\b(all rights reserved|published by|copyright|by [A-Z])/i.test(text.slice(0, 1500)),
    });
    if (rawText.length > text.length) truncated = true;
  }

  return { documents, truncated };
}
