import { useEffect } from 'react';
import type { Bootstrap, ConversationDetail, Message, ServerEvent } from '../../shared/types.ts';
import { keys, queryClient } from './queries.ts';
import { useUI } from './store.ts';

// Sunucudaki tek olay kanalını dinler ve önbelleği yerinde günceller. Üretim
// sunucuda sürdüğü için sayfa değişse de, bağlantı kopup geri gelse de sonuçlar
// kaybolmaz; yeniden bağlanınca açık sohbet baştan eşitlenir.

interface Delta {
  conversationId: string;
  messageId: string;
  partIndex: number;
  offset: number;
  text: string;
}
let deltas: Delta[] = [];
let frame = 0;
let resyncTimer = 0;

/** Bir ek kaçtıysa (bağlantı koptu, sohbet yeni açıldı) sunucudaki canlı hâli yeniden al. */
function resync(conversationId: string): void {
  window.clearTimeout(resyncTimer);
  resyncTimer = window.setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: keys.conversation(conversationId) });
  }, 120);
}

function flushDeltas(): void {
  frame = 0;
  const batch = deltas;
  deltas = [];
  const byConversation = new Map<string, Delta[]>();
  for (const item of batch) {
    const list = byConversation.get(item.conversationId) ?? [];
    list.push(item);
    byConversation.set(item.conversationId, list);
  }
  for (const [conversationId, items] of byConversation) {
    let gap = false;
    queryClient.setQueryData<ConversationDetail>(keys.conversation(conversationId), (detail) => {
      if (!detail) return detail;
      const messages = detail.messages.map((message) => {
        const mine = items.filter((item) => item.messageId === message.id);
        if (!mine.length) return message;
        const parts = [...message.parts];
        for (const item of mine) {
          const part = parts[item.partIndex];
          const current = part?.type === 'text' ? part.text : part ? null : '';
          if (current === null || item.partIndex > parts.length || item.offset > current.length) {
            gap = true;
            continue;
          }
          // Konuma göre yazmak eki yinelenmeye karşı etkisiz kılar.
          parts[item.partIndex] = { type: 'text', text: current.slice(0, item.offset) + item.text };
        }
        return { ...message, parts };
      });
      return { ...detail, messages };
    });
    if (gap) resync(conversationId);
  }
}

function upsertMessage(conversationId: string, message: Message): void {
  queryClient.setQueryData<ConversationDetail>(keys.conversation(conversationId), (detail) => {
    if (!detail) return detail;
    const index = detail.messages.findIndex((m) => m.id === message.id);
    const messages = index >= 0
      ? detail.messages.map((m) => (m.id === message.id ? message : m))
      : [...detail.messages, message];
    return { ...detail, messages };
  });
}

let assetTimer = 0;
function assetsChanged(): void {
  window.clearTimeout(assetTimer);
  assetTimer = window.setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    void queryClient.invalidateQueries({ queryKey: ['entity'] });
  }, 250);
}

let appTimer = 0;
function appChanged(): void {
  window.clearTimeout(appTimer);
  appTimer = window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.bootstrap }), 150);
}

function handle(event: ServerEvent): void {
  const ui = useUI.getState();
  switch (event.type) {
    case 'message.delta':
      deltas.push(event);
      if (!frame) frame = requestAnimationFrame(flushDeltas);
      return;
    case 'message.pending':
      ui.setPending(event.messageId, event.label);
      return;
    case 'message.updated':
      // Önce bekleyen parçaları işle ki tam mesaj eski metnin üzerine yazılmasın.
      if (frame) {
        cancelAnimationFrame(frame);
        flushDeltas();
      }
      upsertMessage(event.conversationId, event.message);
      if (event.message.status !== 'streaming') ui.setPending(event.message.id, null);
      return;
    case 'job.updated': {
      ui.putJobs([event.job]);
      const { conversationId } = event.job;
      if (conversationId) {
        queryClient.setQueryData<ConversationDetail>(keys.conversation(conversationId), (detail) => {
          if (!detail) return detail;
          const exists = detail.jobs.some((j) => j.id === event.job.id);
          return { ...detail, jobs: exists ? detail.jobs.map((j) => (j.id === event.job.id ? event.job : j)) : [event.job, ...detail.jobs] };
        });
      }
      if (event.job.status === 'succeeded') assetsChanged();
      return;
    }
    case 'post.updated': {
      queryClient.setQueryData(keys.post(event.post.id), event.post);
      void queryClient.invalidateQueries({ queryKey: ['posts'] });
      const { conversationId } = event.post;
      if (conversationId) {
        queryClient.setQueryData<ConversationDetail>(keys.conversation(conversationId), (detail) => {
          if (!detail) return detail;
          const exists = detail.posts.some((p) => p.id === event.post.id);
          return { ...detail, posts: exists ? detail.posts.map((p) => (p.id === event.post.id ? event.post : p)) : [...detail.posts, event.post] };
        });
      }
      appChanged();
      return;
    }
    case 'conversation.updated':
      queryClient.setQueryData<Bootstrap>(keys.bootstrap, (app) => {
        if (!app) return app;
        const rest = app.conversations.filter((c) => c.id !== event.conversation.id);
        const conversations = event.conversation.deletedAt ? rest : [event.conversation, ...rest];
        conversations.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
        return { ...app, conversations };
      });
      queryClient.setQueryData<ConversationDetail>(keys.conversation(event.conversation.id), (detail) =>
        detail ? { ...detail, ...event.conversation } : detail,
      );
      return;
    case 'entity.changed':
      appChanged();
      void queryClient.invalidateQueries({ queryKey: keys.entity(event.entityId) });
      return;
    case 'memory.changed':
      void queryClient.invalidateQueries({ queryKey: ['memories'] });
      void queryClient.invalidateQueries({ queryKey: ['entity'] });
      appChanged();
      return;
    case 'asset.changed':
      assetsChanged();
      appChanged();
      return;
    case 'backup.done':
      queryClient.setQueryData<Bootstrap>(keys.bootstrap, (app) =>
        app ? { ...app, backup: { ...app.backup, lastBackupAt: event.at } } : app,
      );
      void queryClient.invalidateQueries({ queryKey: keys.backup });
      return;
    case 'hello':
      return;
  }
}

export function useLive(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let first = true;
    let closed = false;

    const connect = () => {
      source = new EventSource('/api/events');
      source.onmessage = (message) => {
        let event: ServerEvent;
        try {
          event = JSON.parse(message.data) as ServerEvent;
        } catch {
          return;
        }
        if (event.type === 'hello') {
          // Kopukluk sırasında kaçan olayları telafi et.
          if (!first) {
            void queryClient.invalidateQueries({ queryKey: ['conversation'] });
            void queryClient.invalidateQueries({ queryKey: keys.bootstrap });
          }
          first = false;
          return;
        }
        handle(event);
      };
      source.onerror = () => {
        // EventSource kendiliğinden yeniden dener; tamamen kapandıysa elle kur.
        if (source?.readyState === EventSource.CLOSED && !closed) {
          window.setTimeout(connect, 2000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
    };
  }, [enabled]);
}
