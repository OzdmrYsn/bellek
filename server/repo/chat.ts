import type {
  ChatMode, Conversation, ConversationDetail, Job, JobInput, JobStatus, JobType, Mention, Message, MessageOptions,
  MessagePart, MessageStatus, Usage,
} from '../../shared/types.ts';
import { liveParts } from '../ai/live.ts';
import { all, get, newId, now, parseJson, run, type Row } from '../db.ts';
import { emit } from '../events.ts';
import { getAssets } from '../storage.ts';
import { getPosts } from './content.ts';
import { NotFound } from './entities.ts';

// ───────────────────────── Sohbetler ─────────────────────────

function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    pinned: !!row.pinned,
    brandId: (row.brand_id as string | null) ?? null,
    preview: String(row.preview ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

const CONVERSATION_SELECT = `
  SELECT c.*, (
    SELECT substr(m.content, 1, 140) FROM messages m
     WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.seq DESC LIMIT 1
  ) AS preview FROM conversations c`;

export function listConversations(limit = 200): Conversation[] {
  return all<Row>(
    `${CONVERSATION_SELECT} WHERE c.deleted_at IS NULL ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?`,
    limit,
  ).map(toConversation);
}

export function getConversation(id: string): Conversation | undefined {
  const row = get<Row>(`${CONVERSATION_SELECT} WHERE c.id = ?`, id);
  return row ? toConversation(row) : undefined;
}

export function createConversation(input: { title?: string; brandId?: string | null } = {}): Conversation {
  const id = newId('cv');
  const stamp = now();
  run(
    `INSERT INTO conversations (id, title, brand_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    id, input.title?.trim() ?? '', input.brandId ?? null, stamp, stamp,
  );
  const conversation = getConversation(id)!;
  emit({ type: 'conversation.updated', conversation });
  return conversation;
}

export function updateConversation(
  id: string,
  patch: { title?: string; pinned?: boolean; brandId?: string | null; touch?: boolean },
): Conversation {
  const row = get<Row>(`SELECT * FROM conversations WHERE id = ?`, id);
  if (!row) throw new NotFound('Sohbet bulunamadı.');
  run(
    `UPDATE conversations SET title = ?, pinned = ?, brand_id = ?, updated_at = ? WHERE id = ?`,
    patch.title !== undefined ? patch.title.trim().slice(0, 120) : row.title,
    patch.pinned !== undefined ? patch.pinned : row.pinned,
    patch.brandId !== undefined ? patch.brandId : row.brand_id,
    patch.touch ? now() : row.updated_at,
    id,
  );
  const conversation = getConversation(id)!;
  emit({ type: 'conversation.updated', conversation });
  return conversation;
}

export function deleteConversation(id: string): void {
  run(`UPDATE conversations SET deleted_at = ? WHERE id = ?`, now(), id);
  const conversation = getConversation(id);
  if (conversation) emit({ type: 'conversation.updated', conversation });
}

export function restoreConversation(id: string): void {
  run(`UPDATE conversations SET deleted_at = NULL WHERE id = ?`, id);
  const conversation = getConversation(id);
  if (conversation) emit({ type: 'conversation.updated', conversation });
}

// ───────────────────────── Mesajlar ─────────────────────────

function toMessage(row: Row): Message {
  const live = liveParts.get(String(row.id));
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: String(row.content ?? ''),
    parts: live ? structuredClone(live) : parseJson<MessagePart[]>(row.parts, []),
    mode: (row.mode as ChatMode) ?? 'auto',
    mentions: parseJson<Mention[]>(row.mentions, []),
    attachments: parseJson<string[]>(row.attachments, []),
    options: parseJson<MessageOptions>(row.options, {}),
    model: (row.model as string | null) ?? null,
    status: (row.status as MessageStatus) ?? 'done',
    error: (row.error as string | null) ?? null,
    usage: parseJson<Usage | null>(row.usage, null),
    createdAt: String(row.created_at),
  };
}

export function listMessages(conversationId: string): Message[] {
  return all<Row>(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq`, conversationId).map(toMessage);
}

export function getMessage(id: string): Message | undefined {
  const row = get<Row>(`SELECT * FROM messages WHERE id = ?`, id);
  return row ? toMessage(row) : undefined;
}

export function insertMessage(input: {
  conversationId: string; role: 'user' | 'assistant'; content?: string; parts?: MessagePart[]; mode?: ChatMode;
  mentions?: Mention[]; attachments?: string[]; options?: MessageOptions; model?: string | null; status?: MessageStatus;
}): Message {
  const id = newId('ms');
  const next = get<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?`, input.conversationId);
  run(
    `INSERT INTO messages (id, conversation_id, role, content, parts, mode, mentions, attachments, options, model, status, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.conversationId, input.role, input.content ?? '', JSON.stringify(input.parts ?? []), input.mode ?? 'auto',
    JSON.stringify(input.mentions ?? []), JSON.stringify(input.attachments ?? []), JSON.stringify(input.options ?? {}),
    input.model ?? null, input.status ?? 'done', next?.n ?? 1, now(),
  );
  return getMessage(id)!;
}

export function saveMessage(
  id: string,
  patch: { content?: string; parts?: MessagePart[]; status?: MessageStatus; error?: string | null; usage?: Usage | null; model?: string | null },
  announce = true,
): Message {
  const row = get<Row>(`SELECT * FROM messages WHERE id = ?`, id);
  if (!row) throw new NotFound('Mesaj bulunamadı.');
  run(
    `UPDATE messages SET content = ?, parts = ?, status = ?, error = ?, usage = ?, model = ? WHERE id = ?`,
    patch.content !== undefined ? patch.content : row.content,
    patch.parts !== undefined ? JSON.stringify(patch.parts) : row.parts,
    patch.status ?? row.status,
    patch.error !== undefined ? patch.error : row.error,
    patch.usage !== undefined ? (patch.usage ? JSON.stringify(patch.usage) : null) : row.usage,
    patch.model !== undefined ? patch.model : row.model,
    id,
  );
  const message = getMessage(id)!;
  if (announce) emit({ type: 'message.updated', conversationId: message.conversationId, message });
  return message;
}

export function deleteMessagesFrom(conversationId: string, messageId: string): void {
  const row = get<{ seq: number }>(`SELECT seq FROM messages WHERE id = ? AND conversation_id = ?`, messageId, conversationId);
  if (!row) return;
  run(`DELETE FROM messages WHERE conversation_id = ? AND seq >= ?`, conversationId, row.seq);
}

/** Sunucu kapanırken yarım kalan yanıtları "durduruldu" olarak işaretler. */
export function closeDanglingMessages(): void {
  run(`UPDATE messages SET status = 'stopped' WHERE status = 'streaming'`);
}

// ───────────────────────── İşler ─────────────────────────

function toJob(row: Row): Job {
  const assetIds = parseJson<string[]>(row.asset_ids, []);
  return {
    id: String(row.id),
    type: row.type as JobType,
    status: row.status as JobStatus,
    provider: String(row.provider),
    model: String(row.model),
    modelLabel: String(row.model_label || row.model),
    input: parseJson<JobInput>(row.input, { prompt: '', aspect: '1:1', count: 1, refs: [], entityIds: [] }),
    assetIds,
    assets: getAssets(assetIds),
    progress: row.progress === null ? null : Number(row.progress),
    stage: (row.stage as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    messageId: (row.message_id as string | null) ?? null,
    postId: (row.post_id as string | null) ?? null,
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

export function getJob(id: string): Job | undefined {
  const row = get<Row>(`SELECT * FROM jobs WHERE id = ?`, id);
  return row ? toJob(row) : undefined;
}

export function getJobRow(id: string): Row | undefined {
  return get<Row>(`SELECT * FROM jobs WHERE id = ?`, id);
}

export function listJobs(filter: { conversationId?: string; active?: boolean; postId?: string } = {}): Job[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.conversationId) {
    where.push('conversation_id = ?');
    params.push(filter.conversationId);
  }
  if (filter.postId) {
    where.push('post_id = ?');
    params.push(filter.postId);
  }
  if (filter.active) where.push(`status IN ('queued', 'running')`);
  return all<Row>(
    `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`,
    ...params,
  ).map(toJob);
}

export function insertJob(input: {
  type: JobType; provider: string; model: string; modelLabel: string; input: JobInput;
  conversationId?: string | null; messageId?: string | null; postId?: string | null;
}): Job {
  const id = newId('jb');
  run(
    `INSERT INTO jobs (id, type, status, provider, model, model_label, input, conversation_id, message_id, post_id, stage, created_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 'Sırada', ?)`,
    id, input.type, input.provider, input.model, input.modelLabel, JSON.stringify(input.input),
    input.conversationId ?? null, input.messageId ?? null, input.postId ?? null, now(),
  );
  const job = getJob(id)!;
  emit({ type: 'job.updated', job });
  return job;
}

export function saveJob(
  id: string,
  patch: {
    status?: JobStatus; stage?: string | null; progress?: number | null; error?: string | null; assetIds?: string[];
    externalId?: string | null; externalMeta?: Record<string, unknown> | null; input?: JobInput;
    startedAt?: string; finishedAt?: string;
  },
): Job {
  const row = get<Row>(`SELECT * FROM jobs WHERE id = ?`, id);
  if (!row) throw new NotFound('İş bulunamadı.');
  run(
    `UPDATE jobs SET status = ?, stage = ?, progress = ?, error = ?, asset_ids = ?, external_id = ?, external_meta = ?,
            input = ?, started_at = ?, finished_at = ? WHERE id = ?`,
    patch.status ?? row.status,
    patch.stage !== undefined ? patch.stage : row.stage,
    patch.progress !== undefined ? patch.progress : row.progress,
    patch.error !== undefined ? patch.error : row.error,
    patch.assetIds !== undefined ? JSON.stringify(patch.assetIds) : row.asset_ids,
    patch.externalId !== undefined ? patch.externalId : row.external_id,
    patch.externalMeta !== undefined ? (patch.externalMeta ? JSON.stringify(patch.externalMeta) : null) : row.external_meta,
    patch.input !== undefined ? JSON.stringify(patch.input) : row.input,
    patch.startedAt ?? row.started_at,
    patch.finishedAt ?? row.finished_at,
    id,
  );
  const job = getJob(id)!;
  emit({ type: 'job.updated', job });
  return job;
}

export function unfinishedJobs(): Row[] {
  return all<Row>(`SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at`);
}

// ───────────────────────── Sohbet ayrıntısı ─────────────────────────

export function getConversationDetail(id: string): ConversationDetail | undefined {
  const conversation = getConversation(id);
  if (!conversation) return undefined;
  const messages = listMessages(id);
  const jobs = listJobs({ conversationId: id });
  const postIds = messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'post' ? [p.postId] : [])));
  const posts = getPosts(postIds);
  const assetIds = [
    ...messages.flatMap((m) => m.attachments),
    ...jobs.flatMap((j) => j.input.refs.map((r) => r.assetId)),
  ];
  return { ...conversation, messages, jobs, posts, assets: getAssets(assetIds) };
}
