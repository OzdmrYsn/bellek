import { Router } from 'express';
import { paths } from '../config.ts';
import type { MessageOptions, MontageSpec } from '../../shared/types.ts';
import { regenerateTurn, startTurn, stopTurn } from '../ai/orchestrator.ts';
import {
  createCampaignPack, enhancePrompt, generatePostImage, planPosts, postInsights, rewriteCaption, suggestHashtags,
  writeSlides, type CampaignInput, type PlanInput,
} from '../ai/tasks.ts';
import { cancelJob, createGenerationJob, createMontageJob, retryJob, type GenerationSpec } from '../jobs.ts';
import { speechOptions } from '../media/speech.ts';
import {
  createConversation, deleteConversation, getConversationDetail, getJob, listConversations, listJobs,
  updateConversation,
} from '../repo/chat.ts';
import {
  closeReview, createDesign, createPost, decideReview, deleteDesign, deletePost, getCampaign, getDesign, getPost,
  listCampaigns, listDesigns, listPosts, openReview, renameCampaign, reviewAsset, reviewView, updateDesign,
  updatePost, type DesignInput, type PostInput,
} from '../repo/content.ts';
import { NotFound } from '../repo/entities.ts';
import { getAssetRow } from '../storage.ts';
import { query } from './library.ts';
import { triggerIntegrationEvent } from '../integrations.ts';
import { assertConversation, conversationAccess, conversationOfMessage, conversationOwnerFilter } from '../access.ts';
import { can } from '../../shared/permissions.ts';
import { actorOf, need } from '../middleware/auth.ts';
import { getConversation } from '../repo/chat.ts';
import { logActivity } from '../repo/teams.ts';

export const conversationRouter = Router();
export const messageRouter = Router();
export const jobRouter = Router();
export const postRouter = Router();
export const designRouter = Router();
export const generateRouter = Router();
export const campaignRouter = Router();
/** Oturum gerektirmeyen, yalnızca tek bir gönderiyi gösteren onay uçları. */
export const reviewRouter = Router();

// ───────────────────────── Sohbet ─────────────────────────

// Sohbetler kişiseldir: herkes kendininkini görür ve yönetir. "Herkesin sohbetlerini
// görebilir" yetkisi okuma verir; başkasının sohbetine yalnızca takım sahibi yazar.

conversationRouter.get('/', (req, res) => {
  res.json(listConversations(conversationOwnerFilter(actorOf(req))));
});

conversationRouter.post('/', need('studio.generate'), (req, res) => {
  const body = (req.body ?? {}) as { title?: string; brandId?: string | null };
  res.status(201).json(createConversation({ title: body.title, brandId: body.brandId, userId: actorOf(req).id }));
});

conversationRouter.get('/:id', (req, res) => {
  assertConversation(actorOf(req), req.params.id, 'read');
  const detail = getConversationDetail(req.params.id);
  if (!detail || detail.deletedAt) throw new NotFound('Sohbet bulunamadı.');
  res.json(detail);
});

conversationRouter.patch('/:id', (req, res) => {
  assertConversation(actorOf(req), req.params.id, 'write');
  const body = req.body as { title?: string; pinned?: boolean; brandId?: string | null };
  res.json(updateConversation(req.params.id, { title: body.title, pinned: body.pinned, brandId: body.brandId }));
});

conversationRouter.delete('/:id', (req, res) => {
  const actor = actorOf(req);
  assertConversation(actor, req.params.id, 'write');
  const conversation = getConversation(req.params.id);
  deleteConversation(req.params.id);
  if (conversation && !conversation.deletedAt && conversation.userId !== actor.id) {
    logActivity(actor, 'conversation.delete', `Başka bir üyenin “${conversation.title || 'Adsız sohbet'}” sohbetini sildi.`);
  }
  res.json({ ok: true });
});

conversationRouter.post('/:id/messages', need('studio.generate'), (req, res) => {
  const actor = actorOf(req);
  assertConversation(actor, req.params.id, 'write');
  const body = req.body as { content?: string; mode?: string; attachments?: string[]; options?: MessageOptions };
  res.status(201).json(
    startTurn(req.params.id, {
      content: body.content ?? '',
      mode: body.mode,
      attachments: body.attachments,
      options: body.options,
      canRemember: can(actor, 'memory.edit'),
      canPost: can(actor, 'content.edit'),
    }),
  );
});

function assertMessage(req: Parameters<typeof actorOf>[0], messageId: string): void {
  const conversationId = conversationOfMessage(messageId);
  if (!conversationId) throw new NotFound('Yanıt bulunamadı.');
  assertConversation(actorOf(req), conversationId, 'write');
}

messageRouter.post('/:id/stop', need('studio.generate'), (req, res) => {
  assertMessage(req, req.params.id);
  stopTurn(req.params.id);
  res.json({ ok: true });
});

messageRouter.post('/:id/regenerate', need('studio.generate'), (req, res) => {
  assertMessage(req, req.params.id);
  const actor = actorOf(req);
  res.json(regenerateTurn(req.params.id, { canRemember: can(actor, 'memory.edit'), canPost: can(actor, 'content.edit') }));
});

// ───────────────────────── İşler ─────────────────────────

jobRouter.get('/', (req, res) => {
  const actor = actorOf(req);
  const jobs = listJobs({ active: query(req, 'active') === '1', postId: query(req, 'post') || undefined });
  const seen = new Map<string, boolean>();
  res.json(
    jobs.filter((job) => {
      if (!job.conversationId) return true;
      if (!seen.has(job.conversationId)) seen.set(job.conversationId, conversationAccess(actor, job.conversationId) !== 'none');
      return seen.get(job.conversationId);
    }),
  );
});

jobRouter.get('/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new NotFound('İş bulunamadı.');
  if (job.conversationId && conversationAccess(actorOf(req), job.conversationId) === 'none') throw new NotFound('İş bulunamadı.');
  res.json(job);
});

jobRouter.post('/:id/cancel', need('studio.generate'), (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) throw new NotFound('İş bulunamadı.');
  res.json(job);
});

jobRouter.post('/:id/retry', need('studio.generate'), (req, res) => {
  const job = retryJob(req.params.id);
  if (!job) throw new NotFound('İş bulunamadı.');
  res.json(job);
});

/** Sohbet dışından doğrudan üretim (tasarım editörü, hızlı eylemler). */
generateRouter.post('/', need('studio.generate'), (req, res) => {
  const body = req.body as Partial<GenerationSpec> & { assetIds?: string[] };
  const { job } = createGenerationJob({
    type: body.type === 'video' ? 'video' : 'image',
    prompt: String(body.prompt ?? ''),
    userPrompt: body.userPrompt,
    aspect: body.aspect,
    width: body.width,
    height: body.height,
    count: body.count,
    entityIds: body.entityIds ?? [],
    assets: (body.assetIds ?? []).map((assetId) => ({ assetId, label: 'Reference image' })),
    modelRef: body.modelRef,
    duration: body.duration,
    startAssetId: body.startAssetId,
    postId: body.postId,
  });
  res.status(201).json(job);
});

/** Klipleri birleştirir; istenirse seslendirme, altyazı ve logo kapanışı ekler. */
generateRouter.post('/montage', need('studio.generate'), (req, res) => {
  const body = req.body as Partial<MontageSpec>;
  res.status(201).json(
    createMontageJob({
      assetIds: Array.isArray(body.assetIds) ? body.assetIds.map(String) : [],
      width: Number(body.width) || 1080,
      height: Number(body.height) || 1920,
      voiceover: body.voiceover,
      subtitles: !!body.subtitles,
      outroBrandId: body.outroBrandId || undefined,
      title: body.title,
    }),
  );
});

generateRouter.get('/voices', (_req, res) => {
  res.json(speechOptions());
});

generateRouter.post('/enhance', need('studio.generate'), async (req, res) => {
  const body = req.body as { prompt?: string; entityIds?: string[] };
  res.json({ prompt: await enhancePrompt(String(body.prompt ?? ''), body.entityIds ?? []) });
});

// ───────────────────────── Gönderiler ─────────────────────────

postRouter.get('/', (req, res) => {
  res.json(
    listPosts({
      from: query(req, 'from') || undefined,
      to: query(req, 'to') || undefined,
      brandId: query(req, 'brand') || undefined,
      status: query(req, 'status') || undefined,
      campaignId: query(req, 'campaign') || undefined,
    }),
  );
});

postRouter.post('/', need('content.edit'), (req, res) => {
  const post = createPost(req.body as PostInput);
  void triggerIntegrationEvent('post.created', { postId: post.id, post });
  res.status(201).json(post);
});

postRouter.post('/plan', need('content.edit', 'studio.generate'), async (req, res) => {
  res.status(201).json(await planPosts(req.body as PlanInput));
});

postRouter.post('/insights', need('studio.generate'), async (req, res) => {
  res.json(await postInsights((req.body as { brandId?: string | null }).brandId));
});

postRouter.get('/:id', (req, res) => {
  const post = getPost(req.params.id);
  if (!post || post.deletedAt) throw new NotFound('Gönderi bulunamadı.');
  res.json(post);
});

postRouter.patch('/:id', need('content.edit'), (req, res) => {
  const post = updatePost(req.params.id, req.body as PostInput);
  void triggerIntegrationEvent('post.updated', { postId: post.id, post });
  res.json(post);
});

postRouter.delete('/:id', need('content.delete'), (req, res) => {
  const post = getPost(req.params.id);
  deletePost(req.params.id);
  if (post && !post.deletedAt) logActivity(actorOf(req), 'content.delete', `“${post.title || post.caption.slice(0, 50) || 'Adsız gönderi'}” gönderisini sildi.`);
  if (post) void triggerIntegrationEvent('post.deleted', { postId: post.id, post });
  res.json({ ok: true });
});

postRouter.post('/:id/caption', need('content.edit', 'studio.generate'), async (req, res) => {
  const body = req.body as { instruction?: string; draft?: string };
  res.json({ caption: await rewriteCaption(req.params.id, body.instruction ?? '', body.draft) });
});

postRouter.post('/:id/hashtags', need('content.edit', 'studio.generate'), async (req, res) => {
  res.json({ hashtags: await suggestHashtags(req.params.id, (req.body as { draft?: string }).draft) });
});

postRouter.post('/:id/image', need('content.edit', 'studio.generate'), (req, res) => {
  const body = req.body as { prompt?: string; modelRef?: string | null; count?: number };
  res.status(201).json(generatePostImage(req.params.id, body));
});

postRouter.post('/:id/slides', need('content.edit', 'studio.generate'), async (req, res) => {
  const body = req.body as { count?: number; topic?: string };
  res.json(await writeSlides(req.params.id, Number(body.count) || 5, String(body.topic ?? '')));
});

postRouter.post('/:id/review', need('content.edit'), (req, res) => {
  res.status(201).json(openReview(req.params.id));
});

postRouter.delete('/:id/review', need('content.edit'), (req, res) => {
  res.json(closeReview(req.params.id));
});

// ───────────────────────── Kampanyalar ─────────────────────────

campaignRouter.get('/', (_req, res) => {
  res.json(listCampaigns());
});

campaignRouter.post('/', need('content.edit', 'studio.generate'), async (req, res) => {
  const body = req.body as Partial<CampaignInput>;
  res.status(201).json(
    await createCampaignPack({
      brandId: body.brandId,
      brief: String(body.brief ?? ''),
      platforms: Array.isArray(body.platforms) ? body.platforms.map(String) : [],
      generateImages: body.generateImages,
      template: body.template ? String(body.template) : undefined,
      date: body.date,
    }),
  );
});

campaignRouter.get('/:id', (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) throw new NotFound('Kampanya bulunamadı.');
  res.json({ campaign, posts: listPosts({ campaignId: campaign.id }) });
});

campaignRouter.patch('/:id', need('content.edit'), (req, res) => {
  const campaign = renameCampaign(req.params.id, String((req.body as { title?: string }).title ?? ''));
  if (!campaign) throw new NotFound('Kampanya bulunamadı.');
  res.json(campaign);
});

// ───────────────────────── Onay (dışarıya açık) ─────────────────────────

reviewRouter.get('/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(reviewView(req.params.token));
});

reviewRouter.post('/:token', (req, res) => {
  const result = decideReview(req.params.token, req.body as { status?: string; reviewer?: string; comment?: string });
  if (result.post) {
    void triggerIntegrationEvent(
      result.review.status === 'approved' ? 'post.approved' : 'post.changes-requested',
      { review: result.review, post: result.post, brandName: result.brandName },
    );
  }
  res.json(result);
});

reviewRouter.get('/:token/media/:assetId', (req, res) => {
  const row = getAssetRow(reviewAsset(req.params.token, req.params.assetId));
  if (!row) throw new NotFound('Dosya bulunamadı.');
  res.sendFile(String(row.path), {
    root: paths.media,
    dotfiles: 'allow',
    headers: { 'Content-Type': String(row.mime), 'Cache-Control': 'private, max-age=600' },
  });
});

// ───────────────────────── Tasarımlar ─────────────────────────

designRouter.get('/', (_req, res) => {
  res.json(listDesigns());
});

designRouter.post('/', need('content.edit'), (req, res) => {
  res.status(201).json(createDesign(req.body as DesignInput));
});

designRouter.get('/:id', (req, res) => {
  const design = getDesign(req.params.id);
  if (!design || design.deletedAt) throw new NotFound('Tasarım bulunamadı.');
  res.json(design);
});

designRouter.patch('/:id', need('content.edit'), (req, res) => {
  res.json(updateDesign(req.params.id, req.body as DesignInput));
});

designRouter.delete('/:id', need('content.delete'), (req, res) => {
  const design = getDesign(req.params.id);
  deleteDesign(req.params.id);
  if (design && !design.deletedAt) logActivity(actorOf(req), 'content.delete', `“${design.name || 'Adsız tasarım'}” tasarımını sildi.`);
  res.json({ ok: true });
});
