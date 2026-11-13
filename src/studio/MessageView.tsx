import { Brain, Copy, RotateCw, Undo2 } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { findMentions } from '../../shared/handles.ts';
import type { Entity, Message, MessagePart, Post } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { copyText, cx, timeAgo } from '../lib/format.ts';
import { attempt, toast, useUI } from '../lib/store.ts';
import { MentionTag, Notice, Spinner } from '../ui/kit.tsx';
import { JobCard } from './JobCard.tsx';
import { PlanList, PostCard } from './PostCard.tsx';

const MODE_LABEL: Record<Message['mode'], string> = {
  auto: '', text: 'Metin', image: 'Görsel', video: 'Video', post: 'Gönderi',
};

function withMentions(text: string, entities: Entity[]): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const mention of findMentions(text)) {
    const entity = entities.find((e) => e.handle === mention.handle);
    if (!entity) continue;
    if (mention.start > cursor) out.push(text.slice(cursor, mention.start));
    out.push(
      <Link key={mention.start} to={`/hafiza/${entity.id}`} title={entity.name}>
        <MentionTag handle={entity.handle} />
      </Link>,
    );
    cursor = mention.end;
  }
  out.push(text.slice(cursor));
  return out;
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

type Group =
  | { kind: 'text'; text: string; index: number }
  | { kind: 'jobs'; ids: string[] }
  | { kind: 'posts'; ids: string[] }
  | { kind: 'memory'; part: Extract<MessagePart, { type: 'memory' }> }
  | { kind: 'notice'; part: Extract<MessagePart, { type: 'notice' }> };

/** Art arda gelen işleri (karşılaştırma) ve gönderileri (plan) tek blokta toplar. */
function groupParts(parts: MessagePart[]): Group[] {
  const groups: Group[] = [];
  parts.forEach((part, index) => {
    const last = groups[groups.length - 1];
    if (part.type === 'text') groups.push({ kind: 'text', text: part.text, index });
    else if (part.type === 'job') {
      if (last?.kind === 'jobs') last.ids.push(part.jobId);
      else groups.push({ kind: 'jobs', ids: [part.jobId] });
    } else if (part.type === 'post') {
      if (last?.kind === 'posts') last.ids.push(part.postId);
      else groups.push({ kind: 'posts', ids: [part.postId] });
    } else if (part.type === 'memory') groups.push({ kind: 'memory', part });
    else groups.push({ kind: 'notice', part });
  });
  return groups;
}

function MemoryChip({ part }: { part: Extract<MessagePart, { type: 'memory' }> }) {
  return (
    <div className="flex max-w-[38rem] items-start gap-2.5 rounded-xl bg-accent-soft px-3.5 py-2.5 text-[0.88rem] text-accent-text">
      <Brain className="mt-0.5 h-4 w-4 flex-none" />
      <p className="min-w-0 flex-1 leading-snug">
        <span className="font-semibold">Hafızaya alındı: </span>
        {part.content}
      </p>
      <button
        type="button"
        className="flex flex-none items-center gap-1 text-[0.82rem] underline underline-offset-2 hover:no-underline"
        onClick={async () => {
          const ok = await attempt(() => api.del(`/api/memories/${part.memoryId}`));
          if (ok) toast('Not hafızadan çıkarıldı.');
        }}
      >
        <Undo2 className="h-3.5 w-3.5" /> Unut
      </button>
    </div>
  );
}

interface MessageViewProps {
  message: Message;
  entities: Entity[];
  posts: Post[];
  isLast: boolean;
  onRegenerate: (messageId: string) => void;
}

export const MessageView = memo(function MessageView({ message, entities, posts, isLast, onRegenerate }: MessageViewProps) {
  const openLightbox = useUI((s) => s.openLightbox);
  const pending = useUI((s) => s.pending[message.id]);
  const groups = useMemo(() => groupParts(message.parts), [message.parts]);

  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {message.attachments.map((id, index) => (
              <button
                key={id}
                type="button"
                onClick={() => openLightbox(message.attachments, index)}
                className="h-20 w-20 overflow-hidden rounded-xl bg-sunken"
                aria-label="Eki aç"
              >
                <img src={`/media/${id}/thumb`} alt="" className="h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}
        {message.content && (
          <div className="max-w-[min(40rem,88%)] rounded-[18px] rounded-br-md bg-sunken px-4 py-2.5 text-[1rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {withMentions(message.content, entities)}
          </div>
        )}
        {MODE_LABEL[message.mode] && <span className="note pr-1">{MODE_LABEL[message.mode]}</span>}
      </div>
    );
  }

  const streaming = message.status === 'streaming';
  const text = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
  const lastGroup = groups[groups.length - 1];

  return (
    <div className="flex flex-col gap-3.5">
      {groups.map((group, index) => {
        switch (group.kind) {
          case 'text':
            return (
              <div key={index} className={cx('prose-chat', streaming && group === lastGroup && !pending && 'caret')}>
                <Markdown text={group.text} />
              </div>
            );
          case 'jobs':
            return group.ids.length > 1 ? (
              <div key={index} className="flex flex-wrap items-start gap-4">
                {group.ids.map((id) => (
                  <JobCard key={id} jobId={id} compare />
                ))}
              </div>
            ) : (
              <JobCard key={index} jobId={group.ids[0]} />
            );
          case 'posts': {
            const found = group.ids.map((id) => posts.find((p) => p.id === id)).filter((p): p is Post => !!p);
            if (!found.length) return null;
            return found.length >= 3 ? (
              <PlanList key={index} posts={found} />
            ) : (
              <div key={index} className="flex flex-col gap-3">
                {found.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            );
          }
          case 'memory':
            return <MemoryChip key={index} part={group.part} />;
          case 'notice':
            return (
              <div key={index} className="max-w-[38rem]">
                <Notice
                  level={group.part.level}
                  action={
                    group.part.action === 'settings' ? (
                      <Link to="/ayarlar" className="btn btn-outline btn-sm flex-none">
                        Ayarlar
                      </Link>
                    ) : undefined
                  }
                >
                  {group.part.text}
                </Notice>
              </div>
            );
        }
      })}

      {streaming && (pending || groups.length === 0) && (
        <div className="flex items-center gap-2 text-[0.9rem] text-ink-3">
          <Spinner />
          {pending ?? 'Düşünüyor'}
        </div>
      )}

      {message.status === 'stopped' && <p className="text-[0.84rem] text-ink-3">Yanıt durduruldu.</p>}

      {!streaming && (
        <div className="-ml-1.5 flex items-center gap-0.5 text-ink-3">
          {text && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label="Yanıtı kopyala"
              title="Yanıtı kopyala"
              onClick={async () => (await copyText(text)) && toast('Kopyalandı.', 'ok')}
            >
              <Copy />
            </button>
          )}
          {isLast && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label="Yeniden üret"
              title="Aynı istekle yeniden üret"
              onClick={() => onRegenerate(message.id)}
            >
              <RotateCw />
            </button>
          )}
          <span className="note ml-1.5">
            {[message.model, timeAgo(message.createdAt)].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
    </div>
  );
});
