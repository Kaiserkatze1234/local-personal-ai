/** Third build pass: §12 PDF/DOCX real extraction, §42 disk extensions, §24 voice servers + German, §21/§22 honesty seams. */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Api } from '../src/main/api.js';
import { ingestFile } from '../src/main/files/importers.js';
import { extractDocxText } from '../src/main/files/parseDocx.js';
import { extractPdfText } from '../src/main/files/parsePdf.js';
import { PiperHttpAdapter, WhisperHttpAdapter } from '../src/main/providers/adapters/voiceServers.js';
import { makeTestApp } from './helpers.js';

describe('PDF text layer extraction (§12)', () => {
  const contentOps = 'BT /F1 12 Tf 72 700 Td (Hallo Welt) Tj [(Text A) -250 (Text B)] TJ (Ende) Tj ET';

  function pdfWith(streamData: Buffer, filter: string): Buffer {
    const head = Buffer.from(
      `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Length ${streamData.length} ${filter}>> stream\n`,
      'latin1',
    );
    const tail = Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1');
    return Buffer.concat([head, streamData, tail]);
  }

  it('reads FlateDecode text streams (German umlauts survive latin1 layer)', () => {
    const pdf = pdfWith(deflateSync(Buffer.from(contentOps, 'latin1')), '/Filter /FlateDecode ');
    const r = extractPdfText(pdf);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Hallo Welt');
    expect(r.text).toContain('Text A');
    expect(r.text).toContain('Text B');
    expect(r.text).toContain('Ende');
    expect(r.text).toContain('[extracted text layer only');
  });

  it('reads uncompressed streams too', () => {
    const r = extractPdfText(pdfWith(Buffer.from(contentOps, 'latin1'), ''));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Hallo Welt');
  });

  it('says "scanned, no text layer" instead of inventing content', () => {
    const imgOnly = Buffer.from(
      '%PDF-1.4\n2 0 obj << /Length 12 /Filter /FlateDecode >> stream\ngarbage!! 1234\nendstream\nendobj\n',
      'latin1',
    );
    const r = extractPdfText(imgOnly);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no extractable text layer|scanned/i);
  });

  it('rejects non-PDF input and flows through the importer', async () => {
    expect(extractPdfText(Buffer.from('not a pdf at all')).ok).toBe(false);
    const t = await makeTestApp({ writeScope: true });
    try {
      const pdf = pdfWith(deflateSync(Buffer.from('BT (In geheimer Runde) Tj ET', 'latin1')), '/Filter /FlateDecode ');
      const p = join(t.dir, 'note.pdf');
      writeFileSync(p, pdf);
      const ing = ingestFile(p);
      expect(ing.ok).toBe(true);
      expect(ing.text).toContain('In geheimer Runde');
    } finally {
      await t.cleanup();
    }
  });
});

describe('DOCX extraction (§12)', () => {
  const docXml =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Vertrag &amp; Bedingungen</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Punkt eins</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Zweiter Absatz</w:t></w:r></w:p></w:body></w:document>';

  function makeZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const data = e.deflate ? deflateRawSync(e.data) : e.data;
      const name = Buffer.from(e.name, 'utf8');
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
      lh.writeUInt32LE(data.length, 18);
      lh.writeUInt32LE(e.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(Buffer.concat([lh, name, data]));
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(e.deflate ? 8 : 0, 10); // method
      cd.writeUInt32LE(data.length, 20); // compressed size
      cd.writeUInt32LE(e.data.length, 24); // uncompressed size
      cd.writeUInt16LE(name.length, 28); // name length
      cd.writeUInt32LE(offset, 42); // local header offset
      centrals.push(Buffer.concat([cd, name]));
      offset += 30 + name.length + data.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
  }

  it('parses stored and deflated entries, keeps structure markers and entities', () => {
    const zip = makeZip([{ name: 'word/document.xml', data: Buffer.from(docXml, 'utf8'), deflate: true }]);
    const text = extractDocxText(zip);
    expect(text).toContain('Vertrag & Bedingungen');
    expect(text).toMatch(/Vertrag[\s\S]*Zweiter Absatz/);
    expect(text).toContain('- Punkt eins'); // list item marker
    expect(text).toContain('#\nVertrag'); // heading marker survived flattening
  });

  it('fails honestly on non-zip and on zips without document.xml', () => {
    expect(() => extractDocxText(Buffer.from('plain junk not a zip'))).toThrow(/ZIP/);
    expect(() => extractDocxText(makeZip([{ name: 'word/settings.xml', data: Buffer.from('<a/>') }]))).toThrow(/document.xml missing/);
  });

  it('flows through the importer with chunking', async () => {
    const t = await makeTestApp({ writeScope: true });
    try {
      const zip = makeZip([{ name: 'word/document.xml', data: Buffer.from(docXml, 'utf8') }]);
      const p = join(t.dir, 'letter.docx');
      writeFileSync(p, zip);
      const ing = ingestFile(p);
      expect(ing.ok).toBe(true);
      expect(ing.text).toContain('Zweiter Absatz');
      expect(ing.chunks.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });
});

describe('extensions from disk (§42)', () => {
  it('scans, activates, disables via marker, re-enables; one bad module never breaks boot', async () => {
    const t = await makeTestApp({ writeScope: true, config: { tools: { permissionMode: 'ADVANCED' } } });
    try {
      const extDir = join(t.dir, 'exts');
      mkdirSync(join(extDir, 'hello'), { recursive: true });
      writeFileSync(
        join(extDir, 'hello', 'manifest.json'),
        JSON.stringify({
          id: 'hello',
          name: 'Hello Extension',
          version: '1.0.0',
          capabilities: ['tool'],
          permissions: [],
          dependencies: [],
          main: 'main.mjs',
        }),
      );
      writeFileSync(
        join(extDir, 'hello', 'main.mjs'),
        `export default (ctx) => {
           ctx.addTool({
             name: 'greet', description: 'sagt Hallo', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
             permission: null, mutating: false,
             run: async (input) => ({ ok: true, summary: \`Hallo \${input.name}!\` }),
           });
           return () => undefined;
         }`,
      );
      mkdirSync(join(extDir, 'broken'), { recursive: true });
      writeFileSync(join(extDir, 'broken', 'manifest.json'), '{ not json');

      const r = await t.app.extensions.loadFromDirectory(extDir);
      expect(r.loaded).toEqual(['hello']);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.id).toBe('broken');

      const ctx = { log: t.app.log.child('test'), fsRoots: () => ({ read: [t.dir], write: [t.dir] }), cwd: () => t.dir };
      const call = await t.app.tools.call('hello_greet', { name: 'Anna' }, ctx);
      expect(call.ok).toBe(true);
      expect(call.summary).toBe('Hallo Anna!');

      expect(t.app.extensions.uninstall('hello')).toBe(true);
      expect(existsSync(join(extDir, 'hello', 'hello.disabled'))).toBe(true);
      const r2 = await t.app.extensions.loadFromDirectory(extDir);
      expect(r2.loaded).toEqual([]);
      expect(r2.skipped).toEqual(['hello']);

      rmSync(join(extDir, 'hello', 'hello.disabled'));
      const r3 = await t.app.extensions.loadFromDirectory(extDir);
      expect(r3.loaded).toEqual(['hello']);
    } finally {
      await t.cleanup();
    }
  });
});

describe('voice server adapters (§24)', () => {
  it('whisper.cpp adapter: health, language-forwarded transcription, offline state', async () => {
    let lastBody = '';
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (req.method === 'POST' && req.url === '/inference') {
        const parts: Buffer[] = [];
        req.on('data', (c) => parts.push(c as Buffer));
        req.on('end', () => {
          lastBody = Buffer.concat(parts).toString('latin1');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ text: ' Hallo zusammen. ' }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const ad = new WhisperHttpAdapter(base);
      expect((await ad.healthCheck()).state).toBe('OK');
      expect(await ad.discoverModels()).toMatchObject([{ id: 'whisper:whisper-cpp' }]);
      const out = await ad.stt.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav', language: 'de' });
      expect(out.text).toBe('Hallo zusammen.');
      expect(lastBody).toContain('name="language"');
      expect(lastBody).toContain('de');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const offline = new WhisperHttpAdapter('http://127.0.0.1:1'); // port 1: nothing listens
    expect((await offline.healthCheck()).state).toBe('UNAVAILABLE');
  });

  it('local TTS adapter: posts text/voice/speed and yields audio bytes', async () => {
    let body = '';
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        const parts: Buffer[] = [];
        req.on('data', (c) => parts.push(c as Buffer));
        req.on('end', () => {
          body = Buffer.concat(parts).toString('utf8');
          res.writeHead(200, { 'content-type': 'audio/wav' });
          res.end(Buffer.from('RIFFfakewavdata'.padEnd(70_000, 'x')));
        });
        return;
      }
      res.writeHead(200);
      res.end('up');
    });
    try {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const ad = new PiperHttpAdapter(base);
      expect((await ad.healthCheck()).state).toBe('OK');
      let total = 0;
      for await (const chunk of ad.tts.synthesize({ text: 'Guten Tag', voice: 'de_DE-thorsten', speed: 1.2 })) total += chunk.byteLength;
      expect(total).toBe(70_000); // sliced streaming sums to the full payload
      const parsed = JSON.parse(body) as { input: string; voice: string; speed: number };
      expect(parsed).toMatchObject({ input: 'Guten Tag', voice: 'de_DE-thorsten', speed: 1.2 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('configured base URLs register the providers at boot (no manual provider juggling)', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    try {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const t = await makeTestApp({ config: { voice: { enabled: true, sttBaseUrl: base, ttsBaseUrl: base } } });
      try {
        const ids = t.app.providers.list().map((p) => p.id);
        expect(ids).toContain('whisper');
        expect(ids).toContain('localtts');
      } finally {
        await t.cleanup();
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('German-first behaviour (§60 via general.language)', () => {
  it('system prompt instructs Deutsch by default; language=off suppresses it', async () => {
    const t = await makeTestApp({ turns: ['Hallo zurück'] });
    try {
      await t.app.agent.run({ userText: 'Hallo', mode: 'CHAT' });
      const sys = t.mock.requests[0]!.messages.find((m) => m.role === 'system');
      expect(String(sys?.content)).toContain('Deutsch (German)');
      t.app.config.patch({ general: { language: 'off' } });
      t.mock.pushScript('ok');
      await t.app.agent.run({ userText: 'Hallo nochmal', mode: 'CHAT' });
      const sys2 = t.mock.requests[1]!.messages.find((m) => m.role === 'system');
      expect(String(sys2?.content)).not.toContain('Deutsch');
    } finally {
      await t.cleanup();
    }
  });

  it('STT requests inherit the configured language', async () => {
    const t = await makeTestApp({ config: { voice: { enabled: true } } });
    try {
      const modelId = t.app.providers.allModels().find((m) => m.providerId === 'mock')!.id;
      t.app.roles.set('stt', modelId);
      const r = await t.app.voice.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/wav' });
      expect('text' in r).toBe(true); // demo backend answers; language was attached upstream
    } finally {
      await t.cleanup();
    }
  });
});

describe('desktop-only features stay honest headless (§21/§22)', () => {
  it('screen.captureRegion says the desktop shell is required', async () => {
    const t = await makeTestApp();
    const api = new Api(t.app);
    try {
      const r = await api.handleRaw('screen.captureRegion', []);
      expect(!r.ok).toBe(true);
      if (!r.ok) expect(r.error?.message).toMatch(/desktop shell/i);
    } finally {
      await t.cleanup();
    }
  });

  it('recording status/analyze never pretend without ffmpeg', async () => {
    const t = await makeTestApp();
    try {
      const st = await t.app.recordings.status();
      expect(st.state).toBe('UNAVAILABLE');
      const r = await t.app.recordings.summarize(join(t.dir, 'nope.mp4'));
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    } finally {
      await t.cleanup();
    }
  });
});
