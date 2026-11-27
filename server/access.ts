import { can } from '../shared/permissions.ts';
import type { ServerEvent } from '../shared/types.ts';
import { get, type Row } from './db.ts';
import { setEventScope } from './events.ts';
import { NotFound } from './repo/entities.ts';
import { getActor, type Actor } from './repo/teams.ts';

// Sohbetler kişiseldir: herkes kendi sohbetini görür. "Herkesin sohbetlerini
// görebilir" yetkisi okuma verir; başkasının sohbetine yalnızca takım sahibi yazar.

export type ConversationAccess = 'none' | 'read' | 'write';

function accessFor(actor: Pick<Actor, 'id' | 'role' | 'permissions'>, ownerId: string | null): ConversationAccess {
  if (actor.role === 'owner' || ownerId === actor.id) return 'write';
  return can(actor, 'chats.viewAll') ? 'read' : 'none';
}

export function conversationAccess(actor: Actor, conversationId: string): ConversationAccess {
  const row = get<Row>(`SELECT user_id FROM conversations WHERE id = ?`, conversationId);
  if (!row) return 'none';
  return accessFor(actor, (row.user_id as string | null) ?? null);
}

/** Erişim yoksa sohbetin varlığı da belli edilmez. */
export function assertConversation(actor: Actor, conversationId: string, level: 'read' | 'write'): void {
  const access = conversationAccess(actor, conversationId);
  if (access === 'none') throw new NotFound('Sohbet bulunamadı.');
  if (level === 'write' && access !== 'write') throw new NotFound('Bu sohbet başka bir üyeye ait; yalnızca görüntüleyebilirsiniz.');
}

export function conversationOfMessage(messageId: string): string | null {
  return (get<Row>(`SELECT conversation_id FROM messages WHERE id = ?`, messageId)?.conversation_id as string | undefined) ?? null;
}

/** Listeleme sorgularına eklenecek süzgeç: `null` ise kullanıcı her sohbeti görür. */
export function conversationOwnerFilter(actor: Actor): string | null {
  return actor.role === 'owner' || can(actor, 'chats.viewAll') ? null : actor.id;
}

// ───────────────────────── Canlı olayların kapsamı ─────────────────────────

// Akan metin saniyede onlarca olay üretir; sahiplik ve yetki kısa süreli önbellekten okunur.
const owners = new Map<string, string | null>();
const viewers = new Map<string, { at: number; actor: Actor | null }>();

export function forgetAccessCache(): void {
  owners.clear();
  viewers.clear();
}

function ownerOf(conversationId: string): string | null {
  if (owners.has(conversationId)) return owners.get(conversationId) ?? null;
  const owner = (get<Row>(`SELECT user_id FROM conversations WHERE id = ?`, conversationId)?.user_id as string | null | undefined) ?? null;
  if (owners.size > 2000) owners.clear();
  owners.set(conversationId, owner);
  return owner;
}

function viewer(userId: string): Actor | null {
  const cached = viewers.get(userId);
  if (cached && Date.now() - cached.at < 5000) return cached.actor;
  const actor = getActor(userId) ?? null;
  viewers.set(userId, { at: Date.now(), actor });
  return actor;
}

function conversationIdOf(event: ServerEvent): string | null {
  switch (event.type) {
    case 'message.delta':
    case 'message.pending':
    case 'message.updated':
      return event.conversationId;
    case 'conversation.updated':
      return event.conversation.id;
    case 'job.updated':
      return event.job.conversationId ?? null;
    default:
      return null;
  }
}

setEventScope((event, userId) => {
  const conversationId = conversationIdOf(event);
  if (!conversationId) return true;
  const actor = viewer(userId);
  if (!actor || actor.disabled) return false;
  const owner = event.type === 'conversation.updated' ? event.conversation.userId : ownerOf(conversationId);
  return accessFor(actor, owner) !== 'none';
});
