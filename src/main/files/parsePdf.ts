/**
 * Best-effort PDF text extraction for §12 ingestion — no external deps.
 * Strategy: pull content streams (FlateDecode or raw), then read the text
 * showing operators (Tj, TJ, ' and "). This recovers the text layer of
 * digitally generated PDFs (the common case for docs, exports, receipts).
 * Scanned/image-only PDFs have no text layer -> we report that honestly
 * instead of returning fabricated content (§3.8). No ToUnicode CMap
 * reversing: exotic encodings may come out garbled; caller can fall back.
 */
import { inflateSync } from 'node:zlib';

/** Latin-1 keeps byte offsets stable; CMaps beyond latin1 are out of scope. */
const LATIN = 'latin1';

function decodePdfString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch ?? '';
      continue;
    }
    const nxt = raw[++i];
    switch (nxt) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += ' ';
        break;
      case 'f':
        out += ' ';
        break;
      case '(':
      case ')':
      case '\\':
        out += nxt;
        break;
      default: {
        const octal = /^[0-7]{1,3}/.exec(raw.slice(i));
        if (octal) {
          out += String.fromCharCode(parseInt(octal[0], 8));
          i += octal[0].length - 1;
        } else {
          out += nxt ?? '';
        }
      }
    }
  }
  return out;
}

function fromHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  // 4-digit groups are CID fonts — skip those runs rather than emit garbage
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function extractTextOps(content: string): string {
  const parts: string[] = [];
  // (string) Tj  /  (s1) (s2) TJ arrays  /  ' and " line-start operators
  const arrTJ = /\[((?:[^\][\\]|\\.)*)\]\s*TJ/gs;
  let m: RegExpExecArray | null;
  const simple = /\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'")|<([0-9A-Fa-f\s]*)>\s*Tj/gs;
  // First pass: TJ arrays (they swallow the simple strings inside them)
  const masked = content.replace(arrTJ, (whole, inner: string) => {
    let text = '';
    const elem = /\(((?:[^()\\]|\\.)*)\)|(-?[\d.]+)|<([0-9A-Fa-f\s]*)>/g;
    let e: RegExpExecArray | null;
    while ((e = elem.exec(inner)) !== null) {
      if (e[1] !== undefined) text += decodePdfString(e[1]);
      else if (e[3] !== undefined) text += fromHexString(e[3]);
      else if (e[2] !== undefined && Math.abs(parseFloat(e[2])) > 180) text += ' '; // wide kern gap ~ space
    }
    parts.push(text);
    return ' '.repeat(whole.length);
  });
  // Second pass: simple strings that were not inside a TJ array (array spans were blanked)
  while ((m = simple.exec(masked)) !== null) {
    parts.push(m[1] !== undefined ? decodePdfString(m[1]) : fromHexString(m[2] ?? ''));
  }
  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PdfExtractResult {
  ok: boolean;
  text?: string;
  /** Set when the file is parseable but carries no extractable text layer. */
  reason?: string;
}

export function extractPdfText(buf: Buffer): PdfExtractResult {
  const head = buf.subarray(0, 5).toString('ascii');
  if (!head.startsWith('%PDF-')) return { ok: false, reason: 'not a PDF (missing %PDF header)' };
  let foundStreams = 0;
  let sawAny = false;
  const chunks: string[] = [];
  const raw = buf.toString(LATIN);
  let idx = 0;
  for (;;) {
    const start = raw.indexOf('stream', idx);
    if (start === -1) break;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    sawAny = true;
    let dataStart = start + 6;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    // latin1 string offsets == byte offsets in `buf` (1:1 mapping), so slice directly
    const slice = buf.subarray(dataStart, end);
    idx = end + 9;
    // Only try streams whose object header mentions FlateDecode
    const header = raw.slice(Math.max(0, start - 300), start);
    let text: string | null = null;
    if (header.includes('FlateDecode')) {
      try {
        text = inflateSync(Buffer.from(slice.toString(LATIN), LATIN)).toString(LATIN);
      } catch {
        try {
          text = inflateSync(slice).toString(LATIN);
        } catch {
          text = null; // corrupt/unsupported filter — skip this stream
        }
      }
    } else if (/\d+ 0 obj/.test(header) || header.includes('BT')) {
      text = Buffer.from(slice).toString(LATIN);
    }
    if (text !== null && (text.includes('Tj') || text.includes('TJ') || text.includes('BT'))) {
      const extracted = extractTextOps(text);
      if (extracted.length > 0) {
        foundStreams++;
        chunks.push(extracted);
      }
    }
  }
  if (!sawAny) return { ok: false, reason: 'no content streams found (encrypted or malformed PDF)' };
  const text = chunks.join('\n').trim();
  if (foundStreams === 0 || text.length === 0) {
    return {
      ok: false,
      reason: 'no extractable text layer (likely a scanned PDF — OCR is not installed; convert or add an OCR extension)',
    };
  }
  return { ok: true, text: `${text}\n\n[extracted text layer only; layout, images and tables not represented]` };
}
