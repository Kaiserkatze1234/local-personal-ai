/**
 * Screen recording analysis — spec §22. Pipeline: import -> adaptive frame
 * extraction -> event detection -> summarize -> Q&A over frames. Requires
 * ffmpeg + a vision model; either missing => honest UNAVAILABLE (§3.8).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SubLogger } from '../core/logger.js';
import type { VisionService } from '../vision/visionService.js';

const pExecFile = promisify(execFile);

export interface RecordingInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

export interface FrameSample {
  atSec: number;
  path: string;
}

export async function binaryAvailable(name: string): Promise<boolean> {
  try {
    await pExecFile(process.platform === 'win32' ? 'where' : 'which', [name], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export class RecordingAnalysisService {
  constructor(
    private vision: VisionService,
    private log: SubLogger,
  ) {}

  async status(): Promise<{ state: 'OK' | 'UNAVAILABLE'; message: string }> {
    const ffmpeg = (await binaryAvailable('ffmpeg')) && (await binaryAvailable('ffprobe'));
    if (!ffmpeg) return { state: 'UNAVAILABLE', message: 'ffmpeg/ffprobe not found on PATH — install it to enable recording analysis' };
    const vis = this.vision.status();
    if (vis.state !== 'OK') return { state: 'UNAVAILABLE', message: vis.message };
    return { state: 'OK', message: 'ffmpeg + vision model ready' };
  }

  async probe(videoPath: string): Promise<RecordingInfo | null> {
    if (!existsSync(videoPath)) return null;
    try {
      const { stdout } = await pExecFile(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height,r_frame_rate:format=duration',
          '-of',
          'json',
          videoPath,
        ],
        { timeout: 15_000 },
      );
      const j = JSON.parse(stdout) as {
        streams?: { width: number; height: number; r_frame_rate: string }[];
        format?: { duration?: string };
      };
      const s = j.streams?.[0];
      const [num = 30, den = 1] = (s?.r_frame_rate ?? '30/1').split('/').map((x) => Number.parseFloat(x) || 1);
      return {
        durationSec: Number.parseFloat(j.format?.duration ?? '0') || 0,
        width: s?.width ?? 0,
        height: s?.height ?? 0,
        fps: den ? num / den : 30,
      };
    } catch (err) {
      this.log.warn(`ffprobe failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * §22 adaptive sampling: cap frames processed (not every frame at max
   * resolution). ~1 frame per N seconds where N = duration/40, minimum 1.
   */
  planSampling(info: RecordingInfo): { count: number; intervalSec: number; scale: string } {
    const targetFrames = Math.min(40, Math.max(6, Math.floor(info.durationSec / 6)));
    const intervalSec = Math.max(1, info.durationSec / targetFrames);
    const scale = info.width > 1600 ? '1600:-2' : `${info.width}:-2`;
    return { count: Math.ceil(info.durationSec / intervalSec), intervalSec, scale };
  }

  async extractFrames(videoPath: string, info: RecordingInfo, workDir = join(tmpdir(), `lpai-rec-${Date.now()}`)): Promise<FrameSample[]> {
    const plan = this.planSampling(info);
    // ffmpeg does not create output directories — without this the pipeline
    // silently extracted zero frames outside tests (caught by the real-ffmpeg
    // validation added in tests/recording-ffmpeg.test.ts).
    mkdirSync(workDir, { recursive: true });
    const out: FrameSample[] = [];
    for (let i = 0; i < plan.count; i++) {
      const at = i * plan.intervalSec;
      const path = join(workDir, `frame_${String(i).padStart(3, '0')}.jpg`);
      try {
        await pExecFile(
          'ffmpeg',
          ['-ss', at.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${plan.scale}`, '-q:v', '3', '-y', path],
          { timeout: 30_000 },
        );
        if (existsSync(path)) out.push({ atSec: at, path });
      } catch (err) {
        this.log.warn(`frame extraction failed at ${at.toFixed(1)}s: ${(err as Error).message}`);
        break; // input path issues: fail whole pipeline early
      }
    }
    return out;
  }

  /**
   * Summarize the recording: describe sampled frames with the vision model
   * and stitch a sequence summary. Frames are processed at reduced count —
   * the full video is never embedded.
   */
  async summarize(videoPath: string, question?: string): Promise<{ ok: boolean; summary?: string; error?: string }> {
    const st = await this.status();
    if (st.state !== 'OK') return { ok: false, error: `Recording analysis unavailable: ${st.message}.` };
    const info = await this.probe(videoPath);
    if (!info || info.durationSec <= 0) return { ok: false, error: 'Could not read video metadata (is the file valid?).' };
    const workDir = join(tmpdir(), `lpai-rec-${Date.now()}`);
    const frames = await this.extractFrames(videoPath, info, workDir);
    if (frames.length === 0) return { ok: false, error: 'No frames could be extracted.' };
    const descriptions: string[] = [];
    try {
      for (const f of frames.slice(0, 20)) {
        const b64 = (await import('node:fs')).readFileSync(f.path).toString('base64');
        const r = await this.vision.analyzeImages(`${question ?? 'What changed in this frame? 2 bullets max.'}`, [
          { mimeType: 'image/jpeg', dataBase64: b64 },
        ]);
        if ('text' in r) descriptions.push(`[${f.atSec.toFixed(0)}s] ${r.text.trim()}`);
        else return { ok: false, error: r.unavailable };
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true }); // extracted JPEGs are transient
    }
    return {
      ok: true,
      summary: `Recording (${info.durationSec.toFixed(0)}s, ${Math.round(info.fps)}fps), ${frames.length} frame(s) analyzed adaptively:\n${descriptions.join('\n')}`,
    };
  }
}
