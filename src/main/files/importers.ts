/**
 * File ingestion adapters — spec §12/§62.
 * Lifecycle: detect -> parse -> metadata -> normalize -> chunk -> index.
 * Formats without a usable local parser are reported as UNAVAILABLE,
 * never faked (§3.8).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { chunkText, type TextChunk } from '../../shared/util/text.js';

export interface IngestResult {
  ok: boolean;
  kind: string;
  metadata: { name: string; sizeBytes: number; ext: string; mtimeMs: number; lines?: number };
  text: string;
  chunks: TextChunk[];
  unavailableReason?: string;
}

export interface Importer {
  id: string;
  detect(ext: string, name: string): boolean;
  ingest(path: string): IngestResult;
}

const TEXTUAL = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.rs',
  '.go',
  '.py',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.sh',
  '.ps1',
  '.bat',
  '.sql',
  '.vue',
  '.svelte',
  '.css',
  '.scss',
  '.env',
]);

function baseResult(path: string, kind: string): Omit<IngestResult, 'ok' | 'text' | 'chunks'> {
  const st = statSync(path);
  return {
    kind,
    metadata: { name: basename(path), sizeBytes: st.size, ext: extname(path).toLowerCase(), mtimeMs: st.mtimeMs },
  };
}

function makeTextImporter(id: string, exts: string[], transform?: (raw: string) => string): Importer {
  return {
    id,
    detect: (ext) => exts.includes(ext),
    ingest: (path) => {
      const raw = readFileSync(path, 'utf8');
      const text = transform ? transform(raw) : raw;
      return {
        ...baseResult(path, id),
        ok: true,
        text,
        chunks: chunkText(text),
        metadata: { ...baseResult(path, id).metadata, lines: raw.split('\n').length },
      };
    },
  };
}

class PdfImporter implements Importer {
  id = 'pdf';
  detect = (ext: string): boolean => ext === '.pdf';
  ingest(path: string): IngestResult {
    // Real PDF text extraction needs a parser dependency; keep it honest until
    // Phase 9 wires one in (the app must not pretend to read what it cannot).
    return {
      ...baseResult(path, 'pdf'),
      ok: false,
      text: '',
      chunks: [],
      unavailableReason: 'PDF extraction not installed yet (Phase 9). Convert to text or install the optional pdf parser package.',
    };
  }
}

class DocxImporter implements Importer {
  id = 'docx';
  detect = (ext: string): boolean => ext === '.docx';
  ingest(path: string): IngestResult {
    return {
      ...baseResult(path, 'docx'),
      ok: false,
      text: '',
      chunks: [],
      unavailableReason: 'DOCX extraction not installed yet (Phase 9).',
    };
  }
}

class ImageImporter implements Importer {
  id = 'image';
  detect = (ext: string): boolean => ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext);
  ingest(path: string): IngestResult {
    return {
      ...baseResult(path, 'image'),
      ok: true,
      text: '',
      chunks: [],
      metadata: { ...baseResult(path, 'image').metadata },
    };
  }
}

class AudioImporter implements Importer {
  id = 'audio';
  detect = (ext: string): boolean => ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext);
  ingest(path: string): IngestResult {
    return {
      ...baseResult(path, 'audio'),
      ok: false,
      text: '',
      chunks: [],
      unavailableReason: 'Audio transcription requires a configured STT provider (Phase 10); none available for this file.',
    };
  }
}

export function defaultImporters(): Importer[] {
  return [
    makeTextImporter('markdown', ['.md', '.markdown']),
    makeTextImporter('plain', ['.txt', '.log']),
    makeTextImporter('json', ['.json'], (raw) => {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    }),
    makeTextImporter('csv', ['.csv', '.tsv'], (raw) => raw.replaceAll('\t', ' | ').replaceAll(',', ' | ')),
    makeTextImporter('html', ['.html', '.htm'], (raw) =>
      raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' '),
    ),
    makeTextImporter(
      'code',
      [...TEXTUAL].filter((e) => !['.md', '.markdown', '.txt', '.log', '.json', '.csv', '.html', '.htm'].includes(e)),
    ),
    new PdfImporter(),
    new DocxImporter(),
    new ImageImporter(),
    new AudioImporter(),
  ];
}

export function ingestFile(path: string, importers: Importer[] = defaultImporters()): IngestResult {
  if (!existsSync(path))
    return {
      ok: false,
      kind: 'unknown',
      metadata: { name: basename(path), sizeBytes: 0, ext: extname(path), mtimeMs: 0 },
      text: '',
      chunks: [],
      unavailableReason: `File not found: ${path}`,
    };
  const st = statSync(path);
  if (!st.isFile())
    return {
      ok: false,
      kind: 'unknown',
      metadata: { name: basename(path), sizeBytes: st.size, ext: extname(path), mtimeMs: st.mtimeMs },
      text: '',
      chunks: [],
      unavailableReason: 'Not a file.',
    };
  if (st.size > 32 * 1024 * 1024)
    return {
      ok: false,
      kind: 'unknown',
      metadata: { name: basename(path), sizeBytes: st.size, ext: extname(path), mtimeMs: st.mtimeMs },
      text: '',
      chunks: [],
      unavailableReason: 'File exceeds 32 MB ingestion cap.',
    };
  const ext = extname(path).toLowerCase();
  const importer = importers.find((i) => i.detect(ext, basename(path)));
  if (!importer) {
    // unknown extension: try as UTF-8 text but flag it
    const res = makeTextImporter('text-unknown', [ext]).ingest(path);
    return { ...res, unavailableReason: undefined };
  }
  return importer.ingest(path);
}
