import { foldText } from '../../shared/handles.ts';
import { ASPECTS, getFormat, getPlatform } from '../../shared/platforms.ts';
import type {
  ChatMode, Entity, Message, MessageOptions, MessagePart, MessageStatus, Usage,
} from '../../shared/types.ts';
import { emit } from '../events.ts';
import { createGenerationJob } from '../jobs.ts';
import { generateText } from '../providers/index.ts';
import { ProviderError, isAbort, type ChatMessage, type ChatPart } from '../providers/types.ts';
import {
  deleteMessagesFrom, getConversation, getMessage, insertMessage, listMessages, saveMessage, updateConversation,
} from '../repo/chat.ts';
import { createPost } from '../repo/content.ts';
import { createMemory, getEntities, getEntityByHandle, Invalid, listMemories, NotFound } from '../repo/entities.ts';
import { getSettings, pickModel, pickUtilityModel } from '../settings.ts';
import { assetPayload, getAsset, getAssets } from '../storage.ts';
import { ActionStream, innerTag, parseRefs, type ActionTag, type ParsedAction } from './actions.ts';
import { activeBrand, directPrompt, historyTurns, requestContext, resolveMentions, storedPrompt } from './context.ts';
import { liveParts } from './live.ts';
import { TITLE_PROMPT, chatSystemPrompt } from './prompts.ts';

const MODES: ChatMode[] = ['auto', 'text', 'image', 'video', 'post'];
const ASPECT_IDS = new Set(ASPECTS.map((a) => a.id));
const PENDING: Record<ActionTag, string | null> = {
  generate_image: 'Görsel istemi yazılıyor',
  generate_video: 'Video istemi yazılıyor',
  post: 'Gönderi hazırlanıyor',
  remember: null,
};

const turns = new Map<string, AbortController>();

interface TurnContext {
  conversationId: string;
  messageId: string;
  mode: ChatMode;
  options: MessageOptions;
  userText: string;
  attachments: string[];
  entities: Entity[];
  brand: Entity | null;
}

/** Akan yanıtın parçalarını tutar, arayüze yayınlar ve aralıklarla diske yazar. */
class TurnState {
  parts: MessagePart[] = [];
  usage: Usage | null = null;
  model: string | null = null;
  private lastSave = 0;

  constructor(private readonly conversationId: string, private readonly messageId: string) {
    liveParts.set(messageId, this.parts);
  }

  appendText(delta: string): void {
    let last = this.parts[this.parts.length - 1];
    if (!last || last.type !== 'text') {
      delta = delta.replace(/^\s+/, '');
      if (!delta) return;
      last = { type: 'text', text: '' };
      this.parts.push(last);
    }
    const offset = last.text.length;
    last.text += delta;
    emit({
      type: 'message.delta',
      conversationId: this.conversationId,
      messageId: this.messageId,
      partIndex: this.parts.length - 1,
      offset,
      text: delta,
    });
    // Sunucu çökse bile o ana kadar yazılanlar kaybolmasın.
    if (Date.now() - this.lastSave > 800) this.save(false);
  }

  add(part: MessagePart): void {
    const last = this.parts[this.parts.length - 1];
    if (last?.type === 'text') last.text = last.text.replace(/\s+$/, '');
    this.parts.push(part);
    this.save(true);
  }

  pending(label: string | null): void {
    emit({ type: 'message.pending', conversationId: this.conversationId, messageId: this.messageId, label });
  }

  private text(): string {
    return this.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
  }

  private save(announce: boolean): void {
    this.lastSave = Date.now();
    saveMessage(this.messageId, { parts: this.parts, content: this.text() }, announce);
  }

  finish(status: MessageStatus, error: string | null = null): void {
    this.parts = this.parts
      .map((part) => (part.type === 'text' ? { ...part, text: part.text.trim() } : part))
      .filter((part) => part.type !== 'text' || part.text);
    liveParts.delete(this.messageId);
    this.pending(null);
    saveMessage(this.messageId, {
      parts: this.parts, content: this.text(), status, error, usage: this.usage, model: this.model,
    });
  }
}

function asNumber(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

function asAspect(value: string | undefined): string | undefined {
  return value && ASPECT_IDS.has(value) ? value : undefined;
}

function resolveRefs(value: string | undefined, ctx: TurnContext) {
  // Model refs yazmadıysa büyük olasılıkla unutmuştur: mesajda geçen her şeyi kullan.
  if (value === undefined) {
    return {
      entityIds: ctx.entities.map((e) => e.id),
      assets: ctx.attachments.map((assetId) => ({ assetId, label: 'Image attached by the user — the main visual reference' })),
    };
  }
  const tokens = parseRefs(value);
  const entityIds = tokens.handles.map((h) => getEntityByHandle(h)?.id).filter((id): id is string => !!id);
  const assets = tokens.assetIds
    .filter((id) => {
      const asset = getAsset(id);
      return asset && !asset.deletedAt;
    })
    .map((assetId) => ({
      assetId,
      label: ctx.attachments.includes(assetId)
        ? 'Image attached by the user — the main visual reference'
        : 'Earlier image — the one to build on',
    }));
  return { entityIds, assets };
}

function settingsNotice(error: unknown): MessagePart {
  const text = error instanceof Error ? error.message : 'İşlem başlatılamadı.';
  return { type: 'notice', level: 'error', text, action: /Ayarlar/.test(text) ? 'settings' : undefined };
}

function imageJobs(state: TurnState, ctx: TurnContext, prompt: string, attrs: Record<string, string>): void {
  const { entityIds, assets } = resolveRefs(attrs.refs, ctx);
  const models = ctx.options.imageModels?.length ? ctx.options.imageModels.slice(0, 4) : [null];
  for (const modelRef of models) {
    const { job, droppedRefs } = createGenerationJob({
      type: 'image',
      prompt,
      userPrompt: ctx.userText,
      aspect: asAspect(attrs.aspect) ?? ctx.options.aspect,
      // Kullanıcı tam boyut seçtiyse modelin önerdiği oran yerine o geçerlidir.
      width: ctx.options.width,
      height: ctx.options.height,
      count: asNumber(attrs.count) ?? ctx.options.count,
      entityIds,
      assets,
      modelRef,
      quality: ctx.options.quality,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
    });
    state.add({ type: 'job', jobId: job.id });
    if (droppedRefs) {
      state.add({
        type: 'notice', level: 'warn',
        text: `${job.modelLabel} referans görsel alamıyor; bu üretim yalnızca metinden yapıldı.`,
      });
    }
  }
}

function videoJob(state: TurnState, ctx: TurnContext, prompt: string, attrs: Record<string, string>): void {
  const { entityIds, assets } = resolveRefs(attrs.refs, ctx);
  let startAssetId = attrs.from?.match(/asset:([\w-]+)/i)?.[1];
  if (startAssetId && !getAsset(startAssetId)) startAssetId = undefined;
  // Tek bir görsel eklenip "bunu canlandır" dendiğinde o görsel ilk karedir.
  if (!startAssetId && attrs.refs === undefined && !ctx.entities.length) {
    const images = getAssets(ctx.attachments).filter((a) => a.kind === 'image');
    if (images.length === 1) startAssetId = images[0].id;
  }
  const { job, droppedRefs } = createGenerationJob({
    type: 'video',
    prompt,
    userPrompt: ctx.userText,
    aspect: asAspect(attrs.aspect) ?? ctx.options.aspect,
    width: ctx.options.width,
    height: ctx.options.height,
    duration: asNumber(attrs.duration) ?? ctx.options.duration,
    resolution: ctx.options.resolution,
    entityIds,
    assets: startAssetId ? assets.filter((a) => a.assetId !== startAssetId) : assets,
    startAssetId,
    keyframe: ctx.options.keyframe,
    modelRef: ctx.options.videoModel,
    conversationId: ctx.conversationId,
    messageId: ctx.messageId,
  });
  state.add({ type: 'job', jobId: job.id });
  if (droppedRefs) {
    state.add({
      type: 'notice', level: 'warn',
      text: `${job.modelLabel} referans görsel alamıyor ve anahtar kare için bağlı bir görsel modeli yok; video yalnızca metinden üretiliyor.`,
    });
  }
}

function runAction(action: ParsedAction, state: TurnState, ctx: TurnContext): void {
  const generationAllowed = ctx.mode !== 'text';
  switch (action.tag) {
    case 'generate_image':
      if (generationAllowed && action.body) imageJobs(state, ctx, action.body, action.attrs);
      return;
    case 'generate_video':
      if (generationAllowed && action.body) videoJob(state, ctx, action.body, action.attrs);
      return;
    case 'post': {
      if (!generationAllowed) return;
      const caption = innerTag(action.body, 'caption')?.text ?? '';
      const image = innerTag(action.body, 'image_prompt');
      const platform = getPlatform(action.attrs.platform ?? 'instagram');
      const format = getFormat(platform.id, action.attrs.format ?? '');
      const brandId =
        (action.attrs.brand && getEntityByHandle(action.attrs.brand)?.id) ||
        ctx.brand?.id ||
        ctx.entities.find((e) => e.type === 'brand')?.id ||
        null;
      const post = createPost({
        brandId,
        title: innerTag(action.body, 'title')?.text ?? '',
        platform: platform.id,
        format: format.id,
        caption,
        hashtags: innerTag(action.body, 'hashtags')?.text ?? '',
        imagePrompt: storedPrompt(image?.text, image?.attrs.refs),
        scheduledAt: action.attrs.date ?? null,
        conversationId: ctx.conversationId,
        data: { headline: innerTag(action.body, 'headline')?.text, subline: innerTag(action.body, 'subline')?.text },
      });
      state.add({ type: 'post', postId: post.id });
      if (image?.text && action.attrs.generate_image !== 'false') {
        const { entityIds, assets } = resolveRefs(image.attrs.refs, ctx);
        createGenerationJob({
          type: 'image',
          prompt: image.text,
          userPrompt: post.title || caption.slice(0, 80),
          // Gönderi görselleri platformun tam ölçüsünde çıkar.
          width: format.width,
          height: format.height,
          count: 1,
          entityIds,
          assets,
          modelRef: ctx.options.imageModels?.[0],
          conversationId: ctx.conversationId,
          postId: post.id,
        });
      }
      return;
    }
    case 'remember': {
      if (!getSettings().generation.autoMemory) return;
      const content = action.body.replace(/\s+/g, ' ').trim();
      if (!content) return;
      const folded = foldText(content);
      if (listMemories().some((m) => foldText(m.content) === folded)) return;
      const memory = createMemory({
        content,
        category: action.attrs.category,
        entityId: action.attrs.about ? getEntityByHandle(action.attrs.about)?.id ?? null : null,
        source: 'auto',
        sourceMessageId: ctx.messageId,
      });
      state.add({ type: 'memory', memoryId: memory.id, content });
      return;
    }
  }
}

/** Metin modeli olmadan: isteği doğrudan görsel ya da video modeline gönder. */
function directGenerate(type: 'image' | 'video', state: TurnState, ctx: TurnContext): void {
  const prompt = directPrompt(ctx.userText, ctx.entities, ctx.brand);
  if (type === 'image') imageJobs(state, ctx, prompt, {});
  else videoJob(state, ctx, prompt, {});
}

async function llmTurn(state: TurnState, ctx: TurnContext, signal: AbortSignal): Promise<void> {
  const model = pickModel('text', ctx.options.textModel)!;
  const earlier = listMessages(ctx.conversationId).filter((m) => m.id !== ctx.messageId);
  // Son kullanıcı mesajı bağlam bloğuyla yeniden kurulacağı için geçmişten çıkarılır.
  const last = earlier[earlier.length - 1];
  const history = historyTurns(last?.role === 'user' ? earlier.slice(0, -1) : earlier);

  const messages: ChatMessage[] = history.map((turn) => ({ role: turn.role, content: [{ type: 'text', text: turn.text }] }));
  const current: ChatPart[] = [{ type: 'text', text: `${requestContext(ctx)}\n\n${ctx.userText}` }];
  if (model.model.vision !== false) {
    for (const asset of getAssets(ctx.attachments).filter((a) => a.kind === 'image').slice(0, 8)) {
      try {
        current.push({ type: 'image', ...(await assetPayload(asset.id, 1568)) });
      } catch {
        // Okunamayan ek, yanıtı engellemesin.
      }
    }
  }
  messages.push({ role: 'user', content: current });

  state.model = model.model.label;
  let streamed = false;
  const stream = new ActionStream({
    onText: (text) => state.appendText(text),
    onActionStart: (tag) => state.pending(PENDING[tag]),
    onAction: (action) => {
      state.pending(null);
      try {
        runAction(action, state, ctx);
      } catch (error) {
        if (!(error instanceof ProviderError || error instanceof Invalid || error instanceof NotFound)) {
          console.error('[eylem]', error);
        }
        state.add(settingsNotice(error));
      }
    },
  });
  const result = await generateText(model, {
    system: chatSystemPrompt(),
    messages,
    effort: 'medium',
    signal,
    onDelta: (delta) => {
      streamed = true;
      stream.push(delta);
    },
  });
  if (!streamed && result.text) stream.push(result.text);
  stream.end();
  state.usage = result.usage;
}

async function runTurn(ctx: TurnContext, signal: AbortSignal): Promise<void> {
  const state = new TurnState(ctx.conversationId, ctx.messageId);
  const settings = getSettings();
  const textModel = pickModel('text', ctx.options.textModel);
  const enhance = ctx.options.enhance ?? settings.generation.enhance;
  const generative = ctx.mode === 'image' || ctx.mode === 'video';
  try {
    if (generative && (!textModel || !enhance)) {
      directGenerate(ctx.mode as 'image' | 'video', state, ctx);
    } else if (!textModel) {
      if (ctx.mode === 'auto' && pickModel('image')) {
        state.add({
          type: 'notice', level: 'info',
          text: 'Bağlı bir metin modeli olmadığı için isteğiniz doğrudan görsel modeline gönderildi.',
        });
        directGenerate('image', state, ctx);
      } else {
        state.add({
          type: 'notice', level: 'error', action: 'settings',
          text: 'Bu kip için bağlı bir metin modeli gerekiyor. Ayarlar → Yapay zekâlar bölümünden Claude, OpenAI ya da Gemini anahtarı ekleyin.',
        });
      }
    } else {
      await llmTurn(state, ctx, signal);
    }
    state.finish('done');
  } catch (error) {
    if (isAbort(error)) state.finish('stopped');
    else if (error instanceof ProviderError) {
      state.add(settingsNotice(error));
      state.finish('error', error.message);
    } else {
      console.error('[sohbet]', error);
      const message = error instanceof Error ? error.message : 'Beklenmeyen bir hata oluştu.';
      state.add({ type: 'notice', level: 'error', text: message });
      state.finish('error', message);
    }
  } finally {
    turns.delete(ctx.messageId);
    void titleConversation(ctx.conversationId, ctx.userText);
  }
}

async function titleConversation(conversationId: string, userText: string): Promise<void> {
  const conversation = getConversation(conversationId);
  if (!conversation || conversation.title) return;
  const fallback = userText.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Yeni sohbet';
  let title = fallback;
  const model = pickUtilityModel();
  if (model) {
    try {
      const result = await generateText(model, {
        system: TITLE_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText.slice(0, 1200) }] }],
        effort: 'low',
        signal: AbortSignal.timeout(30000),
      });
      const cleaned = result.text.replace(/["“”«»\n]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
      if (cleaned && cleaned.length <= 80) title = cleaned;
    } catch {
      // Başlık üretilemezse mesajın ilk sözcükleri kullanılır.
    }
  }
  if (!getConversation(conversationId)?.title) updateConversation(conversationId, { title });
}

export interface TurnInput {
  content: string;
  mode?: string;
  attachments?: string[];
  options?: MessageOptions;
}

function launch(conversationId: string, user: Message, assistant: Message, entities: Entity[]): void {
  const conversation = getConversation(conversationId)!;
  const controller = new AbortController();
  turns.set(assistant.id, controller);
  const ctx: TurnContext = {
    conversationId,
    messageId: assistant.id,
    mode: user.mode,
    options: user.options,
    userText: user.content,
    attachments: user.attachments,
    entities,
    brand: activeBrand(conversation.brandId),
  };
  void runTurn(ctx, controller.signal);
}

export function startTurn(conversationId: string, input: TurnInput): { user: Message; assistant: Message } {
  const conversation = getConversation(conversationId);
  if (!conversation || conversation.deletedAt) throw new NotFound('Sohbet bulunamadı.');
  const content = (input.content ?? '').trim();
  const attachments = getAssets(input.attachments ?? []).filter((a) => !a.deletedAt).map((a) => a.id);
  if (!content && !attachments.length) throw new Invalid('Bir şeyler yazın ya da bir görsel ekleyin.');
  const mode = MODES.includes(input.mode as ChatMode) ? (input.mode as ChatMode) : 'auto';
  const { mentions, entities } = resolveMentions(content);

  const user = insertMessage({ conversationId, role: 'user', content, mode, mentions, attachments, options: input.options ?? {} });
  const assistant = insertMessage({ conversationId, role: 'assistant', mode, options: input.options ?? {}, status: 'streaming' });
  updateConversation(conversationId, { touch: true });
  emit({ type: 'message.updated', conversationId, message: user });
  emit({ type: 'message.updated', conversationId, message: assistant });
  launch(conversationId, user, assistant, entities);
  return { user, assistant };
}

/** Bir yanıtı ve ardından gelenleri silip aynı istekle yeniden üretir. */
export function regenerateTurn(messageId: string): { assistant: Message } {
  const target = getMessage(messageId);
  if (!target || target.role !== 'assistant') throw new NotFound('Yanıt bulunamadı.');
  const messages = listMessages(target.conversationId);
  const index = messages.findIndex((m) => m.id === messageId);
  const user = messages.slice(0, index).reverse().find((m) => m.role === 'user');
  if (!user) throw new Invalid('Bu yanıtın bağlı olduğu istek bulunamadı.');
  stopTurn(messageId);
  deleteMessagesFrom(target.conversationId, messageId);
  const assistant = insertMessage({
    conversationId: target.conversationId, role: 'assistant', mode: user.mode, options: user.options, status: 'streaming',
  });
  updateConversation(target.conversationId, { touch: true });
  emit({ type: 'message.updated', conversationId: target.conversationId, message: assistant });
  launch(target.conversationId, user, assistant, getEntities(user.mentions.map((m) => m.entityId)));
  return { assistant };
}

export function stopTurn(messageId: string): void {
  turns.get(messageId)?.abort();
}
