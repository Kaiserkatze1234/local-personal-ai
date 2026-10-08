/**
 * Dependency-free DOCX text extraction for §12. A .docx is a ZIP; we read
 * the central directory (sizes are reliable there, unlike local headers that
 * may defer to data descriptors) and inflate word/document.xml. Headers get
 * # markers, list items get "- " so structure survives chunking.
 */
import { inflateRawSync } from 'node:zlib';

function readStr(buf: Buffer, off: number, len: number): string {
  return buf.toString('utf8', off, off + len);
}

export function extractDocxText(buf: Buffer): string {
  // End of Central Directory: PK\x05\x06, fixed 22-byte record, comment may follow
  let eocd = -1;
  const minSearch = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a valid ZIP (no end-of-central-directory)');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let documentXml: Buffer | null = null;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = readStr(buf, off + 46, nameLen);
    if (name === 'word/document.xml') {
      // local header: signature(4)+ver(2)+flags(2)+method(2)+time(4)... nameLen@26 extraLen@28
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      documentXml = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
      if (documentXml === null) throw new Error(`unsupported ZIP compression method ${method}`);
      break;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!documentXml) throw new Error('word/document.xml missing (not a WordprocessingML document?)');
  return documentXmlToText(documentXml.toString('utf8'));
}

export function documentXmlToText(xml: string): string {
  let s = xml;
  s = s.replace(/<w:tab\b[^/]*\/>/g, '\t');
  s = s.replace(/<w:br\b[^/]*\/>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\u0000'); // paragraph boundary marker
  s = s.replace(/<w:pStyle w:val="Heading(\d)"[^>]*\/>/g, (_all, d: string) => `${'#'.repeat(Math.min(6, Number(d) + 0))} \u0001`);
  s = s.replace(/<w:pStyle w:val="Title"[^>]*\/>/g, '# \u0001');
  s = s.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, '\u0002'); // in-paragraph list flag
  s = s.replace(/<[^>]+>/g, ''); // drop all remaining tags
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  // reassemble paragraphs with headings/lists
  const paras = s.split('\u0000');
  const out: string[] = [];
  for (const p0 of paras) {
    const heading = p0.includes('\u0001');
    const list = p0.includes('\u0002');
    const text = p0.split('').join('').split('').join('').trim();
    if (!text) continue;
    if (heading) {
      const hm = /^(#+) (.*)$/s.exec(text);
      out.push(hm ? `${hm[1]}\n${hm[2]}\n` : `## ${text}`);
    } else out.push(list ? `- ${text}` : text);
  }
  return out.join('\n\n');
}
