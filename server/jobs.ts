import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { clampEdge, ratioOf } from '../shared/platforms.ts';
import type { Entity, EntityAssetRole, Job, JobInput, JobOp, JobRef, JobType, MontageSpec } from '../shared/types.ts';
import { paths } from './config.ts';
import { now, parseJson, type Row } from './db.ts';
import { emit } from './events.ts';
import { blendWithMask, fitImage, localUpscale, markupImage, maskFor } from './media/image.ts';
import { buildMontage, fitVideo } from './media/video.ts';
import { FAL_TOOLS, runFalTool } from './providers/fal.ts';
import { adapterFor, videoAcceptsRefs } from './providers/index.ts';
import { ProviderError, isAbort, sleep, type Media, type RefImage } from './providers/types.ts';
import { getJob, getJobRow, insertJob, saveJob, unfinishedJobs } from './repo/chat.ts';
import { attachAssetsToPost } from './repo/content.ts';
import { getEntities, referenceAssets } from './repo/entities.ts';
import { getSecret } from './secrets.ts';
import {
  assertBudget, getProvider, getSettings, isReady, listModels, logUsage, pickModel, resolveModel, type Resolved,
} from './settings.ts';
import { FFMPEG, assetPayload, getAsset, ingest, readAsset } from './storage.ts';

// Üretim işleri veritabanında yaşar: arayüz kapansa da sürer, sunucu yeniden
// başlasa da sağlayıcıdaki video işi kimliğinden sorgulanmaya devam eder.

const MAX_PARALLEL = 4;
const POLL_INTERVAL = 6000;
const VIDEO_TIMEOUT = 40 * 60000;

const controllers = new Map<string, AbortController>();
const waiting: string[] = [];
let active = 0;

// ───────────────────────── İş oluşturma ─────────────────────────

function refLabel(entity: Entity, role: EntityAssetRole): string {
  switch (entity.type) {
    case 'person':
      return `${entity.name} — the person to depict; match the face, hair and build exactly`;
    case 'brand':
      return role === 'logo'
        ? `${entity.name} — the brand logo; reproduce it exactly, do not redraw or restyle it`
        : `${entity.name} — an example of the brand's visual style`;
    case 'product':
      return `${entity.name} — the product; keep its shape, label and colours identical`;
    case 'style':
      return `${entity.name} — visual style reference (mood, palette, lighting), not content`;
    case 'place':
      return `${entity.name} — the location; keep the setting recognisable`;
  }
}

/** Açıkça verilen görseller önce gelir; kalan yer varlıklar arasında sırayla paylaştırılır. */
function buildRefs(spec: GenerationSpec, maxRefs: number): JobRef[] {
  if (maxRefs <= 0) return [];
  const refs: JobRef[] = [];
  const seen = new Set<string>();
  const push = (ref: JobRef) => {
    if (refs.length >= maxRefs || seen.has(ref.assetId)) return;
    seen.add(ref.assetId);
    refs.push(ref);
  };
  for (const item of spec.assets ?? []) push({ assetId: item.assetId, label: item.label });

  const perEntity = getSettings().generation.refsPerEntity;
  const pools = getEntities(spec.entityIds).map((entity) => ({ entity, items: referenceAssets(entity.id, perEntity) }));
  for (let round = 0; round < perEntity; round++) {
    for (const pool of pools) {
      const item = pool.items[round];
      if (item) push({ assetId: item.asset.id, label: refLabel(pool.entity, item.role), entityId: pool.entity.id });
    }
  }
  return refs;
}

export interface GenerationSpec {
  type: JobType;
  prompt: string;
  userPrompt?: string;
  aspect?: string;
  /** Tam piksel boyutu; verilirse oran bundan türetilir. */
  width?: number;
  height?: number;
  count?: number;
  entityIds: string[];
  /** Ek olarak verilen ya da önceki üretimlerden seçilen görseller. */
  assets?: { assetId: string; label: string }[];
  modelRef?: string | null;
  duration?: number;
  resolution?: string;
  quality?: string;
  startAssetId?: string;
  keyframe?: boolean;
  conversationId?: string | null;
  messageId?: string | null;
  postId?: string | null;
}

export interface CreatedJob {
  job: Job;
  /** Model referans alamadığı için referanslar gönderilmedi. */
  droppedRefs: boolean;
}

export function createGenerationJob(spec: GenerationSpec): CreatedJob {
  const resolved = pickModel(spec.type, spec.modelRef);
  if (!resolved) {
    throw new ProviderError(
      spec.type === 'image'
        ? 'Bağlı bir görsel modeli yok. Ayarlar → Yapay zekâlar bölümünden bir sağlayıcı anahtarı ekleyin.'
        : 'Bağlı bir video modeli yok. Ayarlar → Yapay zekâlar bölümünden Google ya da fal.ai anahtarı ekleyin.',
    );
  }
  assertBudget();
  const settings = getSettings().generation;
  const model = resolved.model;
  const wantsRefs = spec.entityIds.length > 0 || (spec.assets?.length ?? 0) > 0;

  let refs: JobRef[] = [];
  let keyframe = false;
  if (spec.type === 'image') {
    refs = buildRefs(spec, model.maxRefs ?? 8);
  } else if (!spec.startAssetId && wantsRefs) {
    // Referansı doğrudan alamayan video modellerinde önce bir anahtar kare üretilir.
    keyframe = !!spec.keyframe || !videoAcceptsRefs(resolved.provider, model);
    const imageModel = keyframe ? pickModel('image') : null;
    if (keyframe && !imageModel) keyframe = false;
    refs = buildRefs(spec, keyframe ? imageModel!.model.maxRefs ?? 8 : model.maxRefs ?? 0);
  }

  const width = clampEdge(spec.width);
  const height = clampEdge(spec.height);
  const exact = width && height ? { width, height } : null;
  const wanted = exact ? ratioOf(exact.width, exact.height) : spec.aspect ?? settings.aspect;
  const aspects = model.aspects;
  const input: JobInput = {
    prompt: spec.prompt.trim(),
    userPrompt: spec.userPrompt?.trim() || undefined,
    aspect: spec.type === 'video' && aspects?.length && !aspects.includes(wanted) ? ratioOf(...ratioPair(wanted), aspects) : wanted,
    count: spec.type === 'image' ? Math.min(4, Math.max(1, Math.round(spec.count ?? settings.count))) : 1,
    refs,
    entityIds: [...new Set(spec.entityIds)],
    quality: spec.quality,
    ...(exact ?? {}),
    ...(spec.type === 'video'
      ? {
          duration: nearestNumber(spec.duration ?? settings.videoDuration, model.durations ?? [5, 8, 10]),
          resolution: spec.resolution,
          startAssetId: spec.startAssetId,
          keyframe,
        }
      : {}),
  };

  const job = insertJob({
    type: spec.type,
    provider: resolved.provider.id,
    model: model.id,
    modelLabel: model.label,
    input,
    conversationId: spec.conversationId,
    messageId: spec.messageId,
    postId: spec.postId,
  });
  schedule(job.id);
  return { job, droppedRefs: wantsRefs && !refs.length && !spec.startAssetId };
}

function ratioPair(aspect: string): [number, number] {
  const [w, h] = aspect.split(':').map(Number);
  return [w || 1, h || 1];
}

function nearestNumber(value: number, options: number[]): number {
  if (!options.length) return value;
  return options.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
}

function falKey(): string | null {
  const fal = getProvider('fal');
  return fal && isReady(fal) && fal.hasKey ? getSecret('fal') : null;
}

export interface ToolSpec {
  op: Exclude<JobOp, 'generate' | 'montage'>;
  sourceAssetId: string;
  /** Bölge düzenlemede ne yapılacağı. */
  prompt?: string;
  /** Bölge düzenlemede maske (PNG; boyalı alan değişir). */
  mask?: Buffer;
  modelRef?: string | null;
}

/** Var olan bir görsel üzerinde çalışan işler: bölge düzenleme, arka plan silme, büyütme. */
export async function createToolJob(spec: ToolSpec): Promise<Job> {
  const source = getAsset(spec.sourceAssetId);
  if (!source || source.deletedAt || source.kind !== 'image') throw new ProviderError('Bu işlem yalnızca görsellerde çalışır.');
  const base: JobInput = {
    op: spec.op,
    sourceAssetId: source.id,
    prompt: (spec.prompt ?? '').trim(),
    aspect: ratioOf(source.width ?? 1, source.height ?? 1),
    count: 1,
    refs: [],
    entityIds: [],
  };

  if (spec.op === 'upscale') {
    const fal = falKey();
    if (fal) assertBudget();
    return queue({
      provider: fal ? 'fal' : 'local',
      model: fal ? FAL_TOOLS.upscale.endpoint : 'lanczos',
      modelLabel: fal ? FAL_TOOLS.upscale.label : 'Yerel büyütme',
      input: base,
    });
  }

  if (spec.op === 'remove-bg' && falKey()) {
    assertBudget();
    return queue({ provider: 'fal', model: FAL_TOOLS.removeBackground.endpoint, modelLabel: FAL_TOOLS.removeBackground.label, input: base });
  }

  // Kalanlar bir görsel modeliyle yapılır: referans alabilen bir model şart.
  const preferred = pickModel('image', spec.modelRef);
  const needed = spec.op === 'inpaint' && preferred?.provider.kind !== 'openai' ? 2 : 1;
  const resolved =
    preferred && (preferred.model.maxRefs ?? 0) >= needed
      ? preferred
      : resolveModel(listModels('image').find((m) => (m.model.maxRefs ?? 0) >= 2)?.ref, 'image');
  if (!resolved) {
    throw new ProviderError(
      spec.op === 'remove-bg'
        ? 'Arka plan silmek için fal.ai anahtarı ya da referans görsel alabilen bir görsel modeli gerekiyor.'
        : 'Bölge düzenlemek için referans görsel alabilen bir görsel modeli bağlayın (ör. Nano Banana ya da GPT Image).',
    );
  }
  assertBudget();

  if (spec.op === 'inpaint') {
    if (!base.prompt) throw new ProviderError('İşaretlediğiniz alanda neyin değişeceğini yazın.');
    if (!spec.mask?.length) throw new ProviderError('Önce değişecek alanı fırçayla işaretleyin.');
    base.maskFile = `${crypto.randomBytes(10).toString('hex')}.png`;
    await fsp.writeFile(path.join(paths.masks, base.maskFile), spec.mask);
  }
  return queue({ provider: resolved.provider.id, model: resolved.model.id, modelLabel: resolved.model.label, input: base });
}

export function createMontageJob(spec: MontageSpec): Job {
  if (!FFMPEG) throw new ProviderError('Montaj için ffmpeg gerekli. Terminalde "brew install ffmpeg" ile kurabilirsiniz.');
  const assetIds = spec.assetIds.filter((id) => {
    const asset = getAsset(id);
    return asset && !asset.deletedAt;
  });
  if (!assetIds.length) throw new ProviderError('Montaj için en az bir video ya da görsel seçin.');
  const width = clampEdge(spec.width) || 1080;
  const height = clampEdge(spec.height) || 1920;
  const voiceover = spec.voiceover?.text.trim() ? { ...spec.voiceover, text: spec.voiceover.text.trim().slice(0, 4000) } : undefined;
  if (voiceover && voiceover.provider !== 'local') assertBudget();
  const input: JobInput = {
    op: 'montage',
    prompt: (spec.title ?? '').trim() || 'Montaj',
    aspect: ratioOf(width, height),
    count: 1,
    refs: [],
    entityIds: spec.outroBrandId ? [spec.outroBrandId] : [],
    montage: { ...spec, assetIds, width, height, voiceover, subtitles: !!spec.subtitles && !!voiceover },
  };
  return queue({ type: 'video', provider: 'local', model: 'ffmpeg', modelLabel: 'Montaj', input });
}

function queue(spec: { type?: JobType; provider: string; model: string; modelLabel: string; input: JobInput }): Job {
  const job = insertJob({ type: spec.type ?? 'image', provider: spec.provider, model: spec.model, modelLabel: spec.modelLabel, input: spec.input });
  schedule(job.id);
  return job;
}

// ───────────────────────── Kuyruk ─────────────────────────

function schedule(jobId: string): void {
  waiting.push(jobId);
  pump();
}

function pump(): void {
  while (active < MAX_PARALLEL && waiting.length) {
    const jobId = waiting.shift()!;
    active++;
    void execute(jobId).finally(() => {
      active--;
      pump();
    });
  }
}

function fail(jobId: string, error: unknown): void {
  controllers.delete(jobId);
  if (isAbort(error)) {
    saveJob(jobId, { status: 'canceled', stage: null, progress: null, error: null, finishedAt: now() });
    return;
  }
  const message =
    error instanceof ProviderError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Beklenmeyen bir hata oluştu.';
  if (!(error instanceof ProviderError)) console.error(`[iş ${jobId}]`, error);
  saveJob(jobId, { status: 'failed', stage: null, progress: null, error: message, finishedAt: now() });
}

async function execute(jobId: string): Promise<void> {
  const row = getJobRow(jobId);
  if (!row || row.status !== 'queued') return;
  const controller = new AbortController();
  controllers.set(jobId, controller);
  saveJob(jobId, { status: 'running', stage: 'Hazırlanıyor', startedAt: now() });
  try {
    const input = parseJson<JobInput>(row.input, {} as JobInput);
    const op = input.op ?? 'generate';
    if (op === 'montage') return await runMontage(jobId, row, input, controller.signal);
    if (op === 'upscale' || (op === 'remove-bg' && row.provider === 'fal')) return await runTool(jobId, row, input, controller.signal);

    const resolved = resolveModel(`${row.provider}:${row.model}`, row.type as JobType);
    if (!resolved) throw new ProviderError('Bu iş için seçilen model artık kullanılamıyor. Ayarlar\'ı kontrol edip yeniden deneyin.');
    if (op === 'inpaint' || op === 'remove-bg') await runEdit(jobId, row, input, resolved, controller.signal);
    else if (row.type === 'image') await runImage(jobId, row, input, resolved, controller.signal);
    else await runVideo(jobId, row, input, resolved, controller.signal);
  } catch (error) {
    fail(jobId, error);
  }
}

async function loadRefs(refs: JobRef[]): Promise<RefImage[]> {
  const loaded = await Promise.all(
    refs.map(async (ref) => {
      try {
        return { ...(await assetPayload(ref.assetId)), label: ref.label };
      } catch {
        // Silinmiş ya da okunamayan referans işi durdurmasın.
        return null;
      }
    }),
  );
  return loaded.filter((ref): ref is RefImage => !!ref);
}

function extensionFor(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  return 'jpg';
}

interface Origin {
  provider: string;
  label: string;
}

async function store(jobId: string, input: JobInput, origin: Origin, media: Media, extra: { title?: string | null; parentId?: string | null; prompt?: string | null } = {}) {
  return ingest({
    data: media.data,
    filename: `bellek-${jobId.slice(-6)}.${extensionFor(media.mime)}`,
    source: 'generated',
    title: extra.title ?? null,
    prompt: extra.prompt !== undefined ? extra.prompt : input.userPrompt ?? input.prompt,
    model: origin.label,
    provider: origin.provider,
    params: {
      finalPrompt: input.prompt,
      aspect: input.aspect,
      refs: input.refs,
      entityIds: input.entityIds,
      ...(input.op && input.op !== 'generate' ? { op: input.op } : {}),
      ...(input.duration ? { duration: input.duration } : {}),
    },
    parentId: extra.parentId !== undefined ? extra.parentId : input.startAssetId ?? input.sourceAssetId ?? null,
    jobId,
  });
}

function finish(jobId: string, row: Row, assetIds: string[]): void {
  controllers.delete(jobId);
  saveJob(jobId, { status: 'succeeded', stage: null, progress: 1, error: null, assetIds, finishedAt: now() });
  if (row.post_id && assetIds.length) attachAssetsToPost(String(row.post_id), [assetIds[0]]);
  emit({ type: 'asset.changed' });
}

const originOf = (resolved: Resolved): Origin => ({ provider: resolved.provider.id, label: resolved.model.label });

async function runImage(jobId: string, row: Row, input: JobInput, resolved: Resolved, signal: AbortSignal): Promise<void> {
  const adapter = adapterFor(resolved);
  if (!adapter.image) throw new ProviderError(`${resolved.provider.name} görsel üretimini desteklemiyor.`);
  const refs = await loadRefs(input.refs);
  const size = input.width && input.height ? { width: input.width, height: input.height } : undefined;
  saveJob(jobId, { stage: 'Üretiliyor' });
  let media = await adapter.image({
    model: resolved.model,
    prompt: input.prompt,
    refs,
    aspect: input.aspect,
    count: input.count,
    quality: input.quality,
    size,
    signal,
    onStage: (stage) => saveJob(jobId, { stage }),
  });
  // Modeller kendi çözünürlüklerinde üretir; istenen ölçü burada kesinleşir.
  if (size) media = await Promise.all(media.map((item) => fitImage(item, size.width, size.height)));
  const assets = [];
  for (const item of media) assets.push(await store(jobId, input, originOf(resolved), item));
  logUsage({ provider: resolved.provider.id, model: resolved.model.id, kind: 'image', units: assets.length });
  finish(jobId, row, assets.map((a) => a.id));
}

function titled(sourceId: string, suffix: string): string {
  const source = getAsset(sourceId);
  return `${source?.title ?? source?.filename.replace(/\.[^.]+$/, '') ?? 'Görsel'} · ${suffix}`;
}

/** Görsel modeliyle yapılan düzenlemeler: maskeli bölge değişimi ve (fal yokken) arka plan silme. */
async function runEdit(jobId: string, row: Row, input: JobInput, resolved: Resolved, signal: AbortSignal): Promise<void> {
  const adapter = adapterFor(resolved);
  if (!adapter.image) throw new ProviderError(`${resolved.provider.name} görsel düzenlemeyi desteklemiyor.`);
  const sourceId = input.sourceAssetId!;
  const payload = await assetPayload(sourceId, 2048);
  const source: RefImage = { ...payload, label: 'The image to edit' };
  saveJob(jobId, { stage: 'Düzenleniyor' });

  if (input.op === 'remove-bg') {
    const [result] = await adapter.image({
      model: resolved.model,
      prompt: 'Remove the background completely and place the subject on a plain pure white background. Keep the subject exactly as it is: same pose, colours, details and proportions.',
      refs: [source],
      aspect: input.aspect,
      count: 1,
      signal,
    });
    const asset = await store(jobId, input, originOf(resolved), result, { title: titled(sourceId, 'arka plansız'), prompt: null });
    logUsage({ provider: resolved.provider.id, model: resolved.model.id, kind: 'image', units: 1 });
    return finish(jobId, row, [asset.id]);
  }

  const maskRaw = await fsp.readFile(path.join(paths.masks, String(input.maskFile))).catch(() => null);
  if (!maskRaw) throw new ProviderError('Bu düzenlemenin maskesi bulunamadı. Alanı yeniden işaretleyin.');
  const mask = await maskFor(payload.data, maskRaw);
  const direct = resolved.provider.kind === 'openai';
  const [edited] = await adapter.image({
    model: resolved.model,
    prompt: direct
      ? `Edit only the masked area: ${input.prompt}. Leave everything outside the mask exactly as it is.`
      : `Edit only the area painted magenta in the second image: ${input.prompt}. Match the lighting, perspective and style of the surroundings. Keep everything outside that area exactly as in the first image. Return the complete edited image with no magenta highlight.`,
    refs: direct
      ? [source]
      : [source, { data: await markupImage(payload.data, mask), mime: 'image/jpeg', label: 'The same image with the area to change painted magenta' }],
    mask: direct ? mask : undefined,
    aspect: input.aspect,
    count: 1,
    signal,
    onStage: (stage) => saveJob(jobId, { stage }),
  });
  // Model başka yerlere dokunmuş olsa da yalnızca işaretli alan özgünün üzerine yazılır.
  const original = await readAsset(sourceId);
  const blended = await blendWithMask(original.data, edited.data, maskRaw);
  const asset = await store(jobId, input, originOf(resolved), blended, { title: titled(sourceId, 'düzenlendi') });
  logUsage({ provider: resolved.provider.id, model: resolved.model.id, kind: 'image', units: 1 });
  finish(jobId, row, [asset.id]);
}

/** Yapay zekâ modeli gerektirmeyen ya da fal araçlarıyla yapılan işler. */
async function runTool(jobId: string, row: Row, input: JobInput, signal: AbortSignal): Promise<void> {
  const sourceId = input.sourceAssetId!;
  const original = await readAsset(sourceId);
  const origin: Origin = { provider: String(row.provider), label: String(row.model_label) };
  let media: Media;
  if (row.provider === 'fal') {
    const key = falKey();
    if (!key) throw new ProviderError('fal.ai anahtarı bulunamadı. Ayarlar\'dan ekleyin.');
    saveJob(jobId, { stage: 'İşleniyor' });
    media = await runFalTool(
      key, String(row.model), { data: original.data, mime: original.mime },
      input.op === 'upscale' ? { upscale_factor: 2 } : {},
      signal, (stage) => saveJob(jobId, { stage }),
    );
    logUsage({ provider: 'fal', model: String(row.model), kind: 'image', units: 1 });
  } else {
    saveJob(jobId, { stage: 'Büyütülüyor' });
    media = await localUpscale(original.data, 2);
  }
  const asset = await store(jobId, input, origin, media, { title: titled(sourceId, input.op === 'upscale' ? '2×' : 'arka plansız'), prompt: null });
  finish(jobId, row, [asset.id]);
}

async function runMontage(jobId: string, row: Row, input: JobInput, signal: AbortSignal): Promise<void> {
  const spec = input.montage as MontageSpec;
  const media = await buildMontage(spec, (stage) => saveJob(jobId, { stage }), signal);
  const asset = await store(jobId, input, { provider: 'local', label: 'Montaj' }, media, {
    title: input.prompt, prompt: spec.voiceover?.text ?? null, parentId: spec.assetIds[0] ?? null,
  });
  finish(jobId, row, [asset.id]);
}

async function runVideo(jobId: string, row: Row, input: JobInput, resolved: Resolved, signal: AbortSignal): Promise<void> {
  const adapter = adapterFor(resolved);
  if (!adapter.videoStart || !adapter.videoPoll) throw new ProviderError(`${resolved.provider.name} video üretimini desteklemiyor.`);

  let start: RefImage | undefined;
  let refs: RefImage[] = [];

  if (input.startAssetId) {
    start = { ...(await assetPayload(input.startAssetId)), label: 'First frame of the video' };
  } else if (input.keyframe && input.refs.length) {
    const imageModel = pickModel('image', input.keyframeModel);
    const imageAdapter = imageModel ? adapterFor(imageModel) : null;
    if (!imageModel || !imageAdapter?.image) {
      throw new ProviderError('Anahtar kare için bağlı bir görsel modeli gerekiyor.');
    }
    saveJob(jobId, { stage: 'Anahtar kare üretiliyor' });
    const [frame] = await imageAdapter.image({
      model: imageModel.model,
      prompt: `${input.prompt}\n\nRender a single photorealistic still: the opening frame of this video. No text, no captions.`,
      refs: await loadRefs(input.refs),
      aspect: input.aspect,
      count: 1,
      signal,
    });
    const frameAsset = await store(jobId, input, originOf(imageModel), frame, { title: 'Anahtar kare', parentId: null });
    logUsage({ provider: imageModel.provider.id, model: imageModel.model.id, kind: 'image', units: 1 });
    input.startAssetId = frameAsset.id;
    saveJob(jobId, { input });
    emit({ type: 'asset.changed' });
    start = { ...(await assetPayload(frameAsset.id)), label: 'First frame of the video' };
  } else {
    refs = await loadRefs(input.refs);
  }

  saveJob(jobId, { stage: 'Video başlatılıyor' });
  const started = await adapter.videoStart({
    model: resolved.model,
    prompt: input.prompt,
    start,
    refs,
    aspect: input.aspect,
    duration: input.duration ?? 8,
    resolution: input.resolution,
    signal,
  });
  if ('media' in started) return await finishVideo(jobId, row, input, resolved, started.media, signal);
  saveJob(jobId, { externalId: started.externalId, externalMeta: started.meta ?? {}, stage: 'Sırada' });
  await pollVideo(jobId, resolved, signal);
}

async function finishVideo(jobId: string, row: Row, input: JobInput, resolved: Resolved, media: Media, signal: AbortSignal): Promise<void> {
  let output = media;
  if (input.width && input.height) {
    saveJob(jobId, { stage: 'Boyut ayarlanıyor' });
    output = await fitVideo(media, input.width, input.height, signal);
  }
  const asset = await store(jobId, input, originOf(resolved), output);
  // Video fiyatları saniye başınadır.
  logUsage({ provider: resolved.provider.id, model: resolved.model.id, kind: 'video', units: Math.round(asset.duration ?? input.duration ?? 1) });
  finish(jobId, row, [asset.id]);
}

async function pollVideo(jobId: string, resolved: Resolved, signal: AbortSignal): Promise<void> {
  const adapter = adapterFor(resolved);
  for (;;) {
    const row = getJobRow(jobId);
    if (!row || row.status !== 'running' || !row.external_id) return;
    if (Date.now() - new Date(String(row.started_at ?? row.created_at)).getTime() > VIDEO_TIMEOUT) {
      throw new ProviderError('Video üretimi beklenen sürede tamamlanmadı. Yeniden deneyin.');
    }
    const result = await adapter.videoPoll!(
      String(row.external_id), parseJson<Record<string, unknown>>(row.external_meta, {}), resolved.model, signal,
    );
    if (result.status === 'succeeded' && result.media) {
      return await finishVideo(jobId, row, parseJson<JobInput>(row.input, {} as JobInput), resolved, result.media, signal);
    }
    if (result.status === 'failed') throw new ProviderError(result.error ?? 'Video üretilemedi.');
    if (result.stage !== row.stage || (result.progress ?? null) !== row.progress) {
      saveJob(jobId, { stage: result.stage ?? 'Üretiliyor', progress: result.progress ?? null });
    }
    await sleep(POLL_INTERVAL, signal);
  }
}

// ───────────────────────── Denetim ─────────────────────────

export function cancelJob(jobId: string): Job | undefined {
  const row = getJobRow(jobId);
  if (!row) return undefined;
  const controller = controllers.get(jobId);
  if (controller) controller.abort();
  else if (row.status === 'queued' || row.status === 'running') {
    const index = waiting.indexOf(jobId);
    if (index >= 0) waiting.splice(index, 1);
    saveJob(jobId, { status: 'canceled', stage: null, progress: null, finishedAt: now() });
  }
  return getJob(jobId);
}

export function retryJob(jobId: string): Job | undefined {
  const row = getJobRow(jobId);
  if (!row) return undefined;
  if (row.status !== 'failed' && row.status !== 'canceled') return getJob(jobId);
  // Anahtar kare zaten üretildiyse girdide durur; yeniden üretilmez.
  saveJob(jobId, { status: 'queued', stage: 'Sırada', progress: null, error: null, externalId: null, externalMeta: null });
  schedule(jobId);
  return getJob(jobId);
}

/** Açılışta yarım kalan işleri toparlar. */
export function resumeJobs(): void {
  for (const row of unfinishedJobs()) {
    const jobId = String(row.id);
    if (row.status === 'queued') {
      schedule(jobId);
      continue;
    }
    if (row.type === 'video' && row.external_id) {
      // Sağlayıcıda süren video: kimliğinden sorgulamaya devam et.
      const resolved = resolveModel(`${row.provider}:${row.model}`, 'video');
      if (!resolved) {
        fail(jobId, new ProviderError('Bu iş için seçilen model artık kullanılamıyor.'));
        continue;
      }
      const controller = new AbortController();
      controllers.set(jobId, controller);
      void pollVideo(jobId, resolved, controller.signal).catch((error) => fail(jobId, error));
      continue;
    }
    fail(jobId, new ProviderError('Sunucu yeniden başlatıldığı için bu üretim yarıda kaldı. Yeniden deneyebilirsiniz.'));
  }
}
