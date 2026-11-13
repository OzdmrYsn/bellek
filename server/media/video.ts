import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MontageSpec } from '../../shared/types.ts';
import { paths } from '../config.ts';
import { ProviderError, type Media } from '../providers/types.ts';
import { entityAssets, getEntity } from '../repo/entities.ts';
import { FFMPEG, FFPROBE, assetFilePath, getAssetRow } from '../storage.ts';
import { outroFrame, subtitleFrame } from './image.ts';
import { synthesize } from './speech.ts';

const NEEDS_FFMPEG = 'Bu işlem için ffmpeg gerekli. Terminalde "brew install ffmpeg" ile kurabilirsiniz.';

function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    const finish = (code: number) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    };
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code ?? -1));
  });
}

export async function ffmpeg(args: string[], signal?: AbortSignal, timeoutMs = 10 * 60000): Promise<void> {
  if (!FFMPEG) throw new ProviderError(NEEDS_FFMPEG);
  const result = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], timeoutMs, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
    throw new ProviderError(`Video işlenemedi${reason ? `: ${reason}` : '.'}`);
  }
}

interface Probe {
  width: number;
  height: number;
  duration: number;
  audio: boolean;
}

export async function probe(file: string): Promise<Probe> {
  if (!FFPROBE) throw new ProviderError(NEEDS_FFMPEG);
  const result = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file], 30000);
  try {
    const info = JSON.parse(result.stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
    const video = info.streams?.find((s) => s.codec_type === 'video');
    return {
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      duration: Number(info.format?.duration ?? 0),
      audio: !!info.streams?.some((s) => s.codec_type === 'audio'),
    };
  } catch {
    return { width: 0, height: 0, duration: 0, audio: false };
  }
}

function tmp(ext: string): string {
  return path.join(paths.tmp, `video-${crypto.randomBytes(8).toString('hex')}.${ext}`);
}

/** Çift sayıya yuvarlar; H.264 tek sayılı kenar kabul etmez. */
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

const fitFilter = (width: number, height: number) =>
  `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,setsar=1,format=yuv420p`;

const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-movflags', '+faststart'];
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];

/** Üretilen videoyu tam istenen piksel ölçüsüne getirir (doldurup ortadan kırparak). */
export async function fitVideo(media: Media, width: number, height: number, signal?: AbortSignal): Promise<Media> {
  if (!FFMPEG) return media;
  const input = tmp('mp4');
  const output = tmp('mp4');
  await fsp.writeFile(input, media.data);
  try {
    const info = await probe(input);
    if (info.width === even(width) && info.height === even(height)) return media;
    await ffmpeg(['-i', input, '-vf', `scale=${even(width)}:${even(height)}:force_original_aspect_ratio=increase,crop=${even(width)}:${even(height)},setsar=1`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-c:a', 'copy', '-movflags', '+faststart', output], signal);
    return { data: await fsp.readFile(output), mime: 'video/mp4' };
  } finally {
    await fsp.rm(input, { force: true });
    await fsp.rm(output, { force: true });
  }
}

/** Seslendirme metnini, okunabilir uzunlukta ve süreye orantılı altyazı parçalarına böler. */
export function subtitleCues(text: string, duration: number, maxChars: number): { lines: string[]; start: number; end: number }[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks: string[][] = [];
  let line = '';
  let lines: string[] = [];
  const flush = () => {
    if (line) lines.push(line);
    if (lines.length) chunks.push(lines);
    line = '';
    lines = [];
  };
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) line = candidate;
    else {
      lines.push(line);
      line = word;
      if (lines.length === 2) {
        chunks.push(lines);
        lines = [];
      }
    }
    // Cümle sonunda parçayı kapat ki altyazı konuşmayla birlikte nefes alsın.
    if (/[.!?…]$/.test(word)) flush();
  }
  flush();
  const total = chunks.reduce((sum, chunk) => sum + chunk.join(' ').length, 0) || 1;
  let cursor = 0;
  return chunks.map((chunk) => {
    const share = (chunk.join(' ').length / total) * duration;
    const cue = { lines: chunk, start: cursor, end: cursor + share };
    cursor += share;
    return cue;
  });
}

/** Klipleri sırayla birleştirir; istenirse seslendirme, altyazı ve logolu kapanış ekler. */
export async function buildMontage(spec: MontageSpec, onStage: (stage: string) => void, signal?: AbortSignal): Promise<Media> {
  if (!FFMPEG || !FFPROBE) throw new ProviderError(NEEDS_FFMPEG);
  const width = even(spec.width);
  const height = even(spec.height);
  const scratch: string[] = [];
  const keep = (file: string) => {
    scratch.push(file);
    return file;
  };

  try {
    // 1) Her klibi aynı ölçü, kare hızı ve ses düzenine getir.
    const clips: string[] = [];
    for (const [index, assetId] of spec.assetIds.entries()) {
      const row = getAssetRow(assetId);
      if (!row || row.deleted_at) continue;
      onStage(`Klipler hazırlanıyor (${index + 1}/${spec.assetIds.length})`);
      const source = assetFilePath(row);
      const clip = keep(tmp('mp4'));
      if (row.kind === 'image') {
        await ffmpeg(['-loop', '1', '-t', '3', '-i', source, ...SILENCE, '-t', '3', '-vf', fitFilter(width, height), '-map', '0:v', '-map', '1:a', '-shortest', ...ENCODE, clip], signal);
      } else if ((await probe(source)).audio) {
        await ffmpeg(['-i', source, '-vf', fitFilter(width, height), ...ENCODE, clip], signal);
      } else {
        await ffmpeg(['-i', source, ...SILENCE, '-vf', fitFilter(width, height), '-map', '0:v', '-map', '1:a', '-shortest', ...ENCODE, clip], signal);
      }
      clips.push(clip);
    }
    if (!clips.length) throw new ProviderError('Montaj için en az bir video ya da görsel seçin.');

    // 2) Kapanış karesi.
    if (spec.outroBrandId) {
      const brand = getEntity(spec.outroBrandId);
      if (brand) {
        onStage('Kapanış hazırlanıyor');
        const logo = entityAssets(brand.id).find((a) => a.role === 'logo') ?? null;
        const logoRow = logo ? getAssetRow(logo.id) : undefined;
        const background = brand.data.colors?.find((c) => c.role === 'background')?.hex ?? brand.data.colors?.find((c) => c.role === 'primary')?.hex ?? '#111111';
        const frame = keep(tmp('png'));
        await fsp.writeFile(frame, await outroFrame(logoRow ? await fsp.readFile(assetFilePath(logoRow)) : null, background, brand.name, width, height));
        const clip = keep(tmp('mp4'));
        await ffmpeg(['-loop', '1', '-t', '2.2', '-i', frame, ...SILENCE, '-t', '2.2', '-vf', `fps=30,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.4`, '-map', '0:v', '-map', '1:a', '-shortest', ...ENCODE, clip], signal);
        clips.push(clip);
      }
    }

    // 3) Birleştir.
    onStage('Klipler birleştiriliyor');
    const list = keep(tmp('txt'));
    await fsp.writeFile(list, clips.map((clip) => `file '${clip.replaceAll("'", "'\\''")}'`).join('\n'));
    const joined = keep(tmp('mp4'));
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', joined], signal);

    const voiceText = spec.voiceover?.text.trim();
    if (!voiceText) return { data: await fsp.readFile(joined), mime: 'video/mp4' };

    // 4) Seslendirme ve altyazı.
    onStage('Seslendiriliyor');
    const voice = keep(await synthesize(spec.voiceover!.provider, voiceText, spec.voiceover!.voice, signal));
    const voiceDuration = (await probe(voice)).duration;
    const videoDuration = (await probe(joined)).duration;
    const total = Math.max(videoDuration, voiceDuration + 0.5);
    const extend = Math.max(0, total - videoDuration);

    const inputs = ['-i', joined, '-i', voice];
    const filters: string[] = [`[0:v]tpad=stop_mode=clone:stop_duration=${extend.toFixed(2)}[v0]`];
    let last = 'v0';
    if (spec.subtitles) {
      onStage('Altyazı hazırlanıyor');
      const maxChars = Math.max(14, Math.floor((width * 0.84) / (Math.min(width, height) * 0.048 * 0.56)));
      const cues = subtitleCues(voiceText, voiceDuration, maxChars).slice(0, 60);
      for (const [index, cue] of cues.entries()) {
        const frame = keep(tmp('png'));
        await fsp.writeFile(frame, await subtitleFrame(cue.lines, width, height));
        inputs.push('-i', frame);
        const next = `v${index + 1}`;
        filters.push(`[${last}][${index + 2}:v]overlay=0:0:enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'[${next}]`);
        last = next;
      }
    }
    // Özgün ses kısılır, anlatım üstüne biner.
    filters.push(`[0:a]volume=0.22,apad[a0]`, `[1:a]apad[a1]`, `[a0][a1]amix=inputs=2:duration=longest:normalize=0[a]`);

    onStage('Video oluşturuluyor');
    const output = keep(tmp('mp4'));
    await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', `[${last}]`, '-map', '[a]', '-t', total.toFixed(2), ...ENCODE, output], signal);
    return { data: await fsp.readFile(output), mime: 'video/mp4' };
  } finally {
    await Promise.all(scratch.map((file) => fsp.rm(file, { force: true })));
  }
}
