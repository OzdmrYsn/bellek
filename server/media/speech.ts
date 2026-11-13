import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SpeechOption, SpeechProvider } from '../../shared/types.ts';
import { paths } from '../config.ts';
import { createAdapter } from '../providers/index.ts';
import { ProviderError } from '../providers/types.ts';
import { getSecret } from '../secrets.ts';
import { getProvider, isReady } from '../settings.ts';
import { ffmpeg } from './video.ts';

const SAY = process.platform === 'darwin' && fs.existsSync('/usr/bin/say') ? '/usr/bin/say' : null;

let localVoices: { id: string; label: string }[] | null = null;

/** macOS'un yerleşik sesleri: anahtar ve internet gerektirmez. */
function listLocalVoices(): { id: string; label: string }[] {
  if (localVoices) return localVoices;
  localVoices = [];
  if (!SAY) return localVoices;
  const output = spawnSync(SAY, ['-v', '?'], { encoding: 'utf8' }).stdout ?? '';
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/);
    if (!match) continue;
    const name = match[1].replace(/\s*\(.*\)\s*$/, '').trim();
    const locale = match[2];
    if (seen.has(name) || !['tr_TR', 'en_US', 'en_GB'].includes(locale)) continue;
    // İngilizce seslerin çoğu şaka amaçlıdır; yalnızca doğal olanları göster.
    if (locale !== 'tr_TR' && !['Samantha', 'Alex', 'Daniel', 'Karen', 'Moira'].includes(name)) continue;
    seen.add(name);
    localVoices.push({ id: name, label: `${name} · ${locale === 'tr_TR' ? 'Türkçe' : 'İngilizce'}` });
  }
  localVoices.sort((a, b) => Number(b.label.includes('Türkçe')) - Number(a.label.includes('Türkçe')));
  return localVoices;
}

const OPENAI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'nova', 'onyx'];
const GOOGLE_VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];

function ready(id: string): boolean {
  const provider = getProvider(id);
  return !!provider && isReady(provider) && provider.hasKey;
}

export function speechOptions(): SpeechOption[] {
  const options: SpeechOption[] = [];
  if (ready('openai')) options.push({ provider: 'openai', label: 'OpenAI', voices: OPENAI_VOICES.map((v) => ({ id: v, label: v })) });
  if (ready('google')) options.push({ provider: 'google', label: 'Gemini', voices: GOOGLE_VOICES.map((v) => ({ id: v, label: v })) });
  const local = listLocalVoices();
  if (local.length) options.push({ provider: 'local', label: 'Bu bilgisayarın sesi', voices: local });
  return options;
}

/** Metni seslendirir ve 44,1 kHz stereo WAV dosyasının yolunu döndürür. */
export async function synthesize(provider: SpeechProvider, text: string, voice: string | undefined, signal?: AbortSignal): Promise<string> {
  const id = crypto.randomBytes(8).toString('hex');
  const out = path.join(paths.tmp, `ses-${id}.wav`);
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new ProviderError('Seslendirilecek metin boş.');

  if (provider === 'local') {
    if (!SAY) throw new ProviderError('Bu bilgisayarda yerleşik seslendirme yok. OpenAI ya da Gemini anahtarı ekleyin.');
    const raw = path.join(paths.tmp, `ses-${id}.aiff`);
    const chosen = listLocalVoices().find((v) => v.id === voice)?.id ?? listLocalVoices()[0]?.id;
    const result = spawnSync(SAY, [...(chosen ? ['-v', chosen] : []), '-o', raw, clean], { encoding: 'utf8', timeout: 120000 });
    if (result.status !== 0) throw new ProviderError('Yerleşik seslendirme başarısız oldu.');
    try {
      await ffmpeg(['-i', raw, '-ar', '44100', '-ac', '2', out]);
    } finally {
      await fsp.rm(raw, { force: true });
    }
    return out;
  }

  const info = getProvider(provider);
  if (!info || !ready(provider)) throw new ProviderError('Seçilen seslendirme sağlayıcısı bağlı değil. Ayarlar\'dan anahtar ekleyin.');
  const adapter = createAdapter(info, getSecret(info.id));
  if (!adapter.speech) throw new ProviderError(`${info.name} seslendirmeyi desteklemiyor.`);
  const media = await adapter.speech({ text: clean, voice, signal });
  const pcm = /L16|pcm/i.test(media.mime);
  const raw = path.join(paths.tmp, `ses-${id}.${pcm ? 'pcm' : 'mp3'}`);
  await fsp.writeFile(raw, media.data);
  try {
    const rate = media.mime.match(/rate=(\d+)/)?.[1] ?? '24000';
    await ffmpeg([...(pcm ? ['-f', 's16le', '-ar', rate, '-ac', '1'] : []), '-i', raw, '-ar', '44100', '-ac', '2', out]);
  } finally {
    await fsp.rm(raw, { force: true });
  }
  return out;
}
