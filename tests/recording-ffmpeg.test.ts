/**
 * §22 validation with REAL ffmpeg/ffprobe (item from the user's audit:
 * "recording -> extract frames -> vision -> events -> summary needs
 * real-world testing"). Generates an actual video with ffmpeg, then runs the
 * production pipeline end to end: probe -> adaptive sampling -> real JPEG
 * extraction -> per-frame vision calls -> stitched summary.
 *
 * The vision model here is the built-in demo mock (explicitly not real AI) —
 * what this proves is the plumbing with real binaries. Summary QUALITY with a
 * real vision model stays a hardware item (CHECKLIST §B).
 *
 * The test auto-SKIPS when the dev-only static binaries aren't installed:
 *   npm i --no-save ffmpeg-static ffprobe-static
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);

function locateBinaries(): { ffmpeg: string; ffprobe: string } | null {
  try {
    const ffmpeg = nodeRequire('ffmpeg-static') as unknown;
    const ffprobeMod = nodeRequire('ffprobe-static') as { path?: string };
    const ffprobe = typeof ffprobeMod?.path === 'string' ? ffprobeMod.path : null;
    if (typeof ffmpeg === 'string' && ffprobe && existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe };
  } catch {
    /* packages absent -> skip */
  }
  return null;
}

const bins = locateBinaries();
const suite = bins ? describe : describe.skip;

const origPath = process.env.PATH;
let shimDir: string | null = null;

suite('recording analysis with real ffmpeg', () => {
  beforeAll(() => {
    if (!bins) return;
    // expose the static binaries under the bare names the service probes for
    shimDir = mkdtempSync(join(tmpdir(), 'lpai-ffm-'));
    const exe = process.platform === 'win32' ? '.exe' : '';
    copyFileSync(bins.ffmpeg, join(shimDir, `ffmpeg${exe}`));
    copyFileSync(bins.ffprobe, join(shimDir, `ffprobe${exe}`));
    process.env.PATH = `${shimDir}${process.platform === 'win32' ? ';' : ':'}${String(origPath)}`;
  });

  afterAll(() => {
    process.env.PATH = origPath;
    if (shimDir) rmSync(shimDir, { recursive: true, force: true });
  });

  it('probe -> adaptive frames -> vision per frame -> stitched summary (real JPEGs on disk)', async () => {
    const t = await makeTestApp();
    const dir = mkdtempSync(join(tmpdir(), 'lpai-rec-'));
    try {
      // 1) a REAL 6-second video, 640x480 @ 25fps
      const video = join(dir, 'session.avi');
      execFileSync(
        'ffmpeg',
        ['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25', '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'mpeg4', '-y', video],
        {
          stdio: 'ignore',
          timeout: 60_000,
        },
      );
      expect(existsSync(video)).toBe(true);

      // 2) the status gate must now pass (ffmpeg on PATH + vision model bound)
      const st = await t.app.recordings.status();
      expect(st.state).toBe('OK');

      // 3) real metadata through ffprobe
      const info = await t.app.recordings.probe(video);
      expect(info).not.toBeNull();
      expect(info?.width).toBe(640);
      expect(info?.height).toBe(480);
      expect(Math.abs((info?.durationSec ?? 0) - 6)).toBeLessThan(0.6);
      expect(Math.round(info?.fps ?? 0)).toBe(25);

      // 4) adaptive sampling plan for 6s: 6 frames, 1s apart (not 150)
      const plan = t.app.recordings.planSampling(info!);
      expect(plan.count).toBe(6);
      expect(plan.intervalSec).toBe(1);

      // 5) frames are real JPEG files extracted by ffmpeg
      const frames = await t.app.recordings.extractFrames(video, info!, join(dir, 'frames'));
      expect(frames.length).toBe(6);
      for (const f of frames) {
        const bytes = readFileSync(f.path);
        expect(bytes[0]).toBe(0xff); // JPEG magic FFD8FF — real image, not a stub
        expect(bytes[1]).toBe(0xd8);
        expect(bytes[2]).toBe(0xff);
        expect(bytes.length).toBeGreaterThan(2000);
      }

      // 6) full summarize through the production entry point: every frame
      // reaches the model with its image bytes, summary stitches timestamps.
      for (let i = 0; i < 6; i++) t.mock.pushScript(`frame ${String(i)}: UI state ${i} changed — dialog closed`);
      const res = await t.app.recordings.summarize(video, 'Did the settings dialog close?');
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('6 frame(s) analyzed');
      expect(res.summary).toContain('[0s]');
      expect(res.summary).toContain('dialog closed');
      const visionReqs = t.mock.requests.filter((r) => Array.isArray(r.messages[0]?.content));
      expect(visionReqs.length).toBe(6);
      for (const req of visionReqs) {
        const content = req.messages[0]?.content;
        expect(Array.isArray(content)).toBe(true);
        const img = (content as { type: string; dataBase64?: string }[]).find((c) => c.type === 'image');
        expect((img?.dataBase64?.length ?? 0) > 1000).toBe(true); // real bytes went to the model
      }

      // 7) honesty check with ffmpeg PRESENT: garbage input still fails cleanly
      const junk = join(dir, 'junk.mp4');
      writeFileSync(junk, 'not a video');
      const bad = await t.app.recordings.summarize(junk);
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('video metadata');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await t.cleanup();
    }
  }, 180_000);
});
