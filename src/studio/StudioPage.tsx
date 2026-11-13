import { ArrowDown, Check, ChevronDown, CircleDashed, MoreHorizontal, Pin, PinOff, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ChatMode, Conversation, ConversationDetail, Entity, Message } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { keys, queryClient, refreshApp, useApp, useConversation } from '../lib/queries.ts';
import { attempt, toast, useUI } from '../lib/store.ts';
import { Avatar, Empty, IconButton, PageLoader } from '../ui/kit.tsx';
import { Menu, Popover } from '../ui/Popover.tsx';
import { Composer, type SendPayload } from './Composer.tsx';
import { MessageView } from './MessageView.tsx';

function BrandContext({ brand, brands, onChange }: { brand: Entity | null; brands: Entity[]; onChange: (id: string | null) => void }) {
  if (!brands.length) return null;
  return (
    <Popover
      placement="bottom-end"
      className="w-64"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={cx('btn btn-sm', brand ? 'btn-outline !pl-1.5' : 'btn-ghost')}
          title="Sohbete sabitlenen marka her isteğe eklenir"
        >
          {brand ? <Avatar entity={brand} size={22} /> : null}
          <span className="max-w-32 truncate">{brand ? brand.name : 'Marka bağlamı'}</span>
          <ChevronDown className="!h-3.5 !w-3.5 text-ink-3" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <p className="px-2.5 pt-1.5 pb-2 text-[0.8rem] leading-snug text-ink-3">
            Seçtiğiniz markanın kimliği, @ ile anmasanız da bu sohbetteki her isteğe eklenir.
          </p>
          <button type="button" className="menu-item" onClick={() => { onChange(null); close(); }}>
            <span className="grid h-6 w-6 place-items-center"><CircleDashed /></span>
            <span className="flex-1">Marka yok</span>
            {!brand && <Check />}
          </button>
          {brands.map((item) => (
            <button key={item.id} type="button" className="menu-item" onClick={() => { onChange(item.id); close(); }}>
              <Avatar entity={item} size={24} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {brand?.id === item.id && <Check />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

interface Starter {
  text: string;
  mode: ChatMode;
}

function starters(entities: Entity[]): Starter[] {
  const person = entities.find((e) => e.type === 'person');
  const brand = entities.find((e) => e.type === 'brand');
  const product = entities.find((e) => e.type === 'product');
  const list: Starter[] = [];
  if (person) list.push({ text: `@${person.handle} için stüdyo ışığında, sade arka planlı profesyonel bir portre`, mode: 'image' });
  if (brand) list.push({ text: `@${brand.handle} için önümüzdeki haftanın içerik planını çıkar`, mode: 'auto' });
  if (person && brand) list.push({ text: `@${person.handle} @${brand.handle} ofisinde çalışırken; doğal ışık, belgesel havası`, mode: 'image' });
  if (brand && product) list.push({ text: `@${product.handle} için @${brand.handle} renklerinde bir tanıtım gönderisi hazırla`, mode: 'post' });
  if (brand) list.push({ text: `@${brand.handle} için yeni müşteri karşılama gönderisi hazırla`, mode: 'post' });
  if (person) list.push({ text: `@${person.handle} sahilde yürürken, gün batımında kısa bir video`, mode: 'video' });
  if (list.length < 3) {
    list.push(
      { text: 'Butik bir kahve dükkânı için Instagram gönderisi hazırla', mode: 'post' },
      { text: 'Sabah ışığında mermer masada duran bir seramik fincan; minimal ürün fotoğrafı', mode: 'image' },
      { text: 'Yeni açılan bir pilates stüdyosu için 5 gönderilik tanıtım planı çıkar', mode: 'auto' },
    );
  }
  return list.slice(0, 4);
}

function Welcome({ onSend }: { onSend: (payload: SendPayload) => Promise<boolean> }) {
  const app = useApp();
  const setDraft = useUI((s) => s.setDraft);
  const setMode = useUI((s) => s.setMode);
  const hasModel = app.models.length > 0;
  const hasPerson = app.entities.some((e) => e.type === 'person');
  const hasBrand = app.entities.some((e) => e.type === 'brand');
  const steps = [
    { done: hasModel, title: 'Yapay zekânı bağla', body: 'Claude, OpenAI, Gemini ya da fal.ai anahtarını ekle.', to: '/ayarlar' },
    { done: hasPerson, title: 'İlk kişini ekle', body: 'Birkaç fotoğraf yükle, @ad ile çağır.', to: '/hafiza?yeni=person' },
    { done: hasBrand, title: 'Markanı tanıt', body: 'Logo, renkler ve ses tonu bir kez girilir.', to: '/hafiza?yeni=brand' },
  ];
  const ready = steps.every((s) => s.done);
  const ideas = useMemo(() => starters(app.entities), [app.entities]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[48rem] flex-col justify-center px-6 py-10 max-md:px-4">
        <h1 className="text-[clamp(1.7rem,4vw,2.4rem)] leading-[1.12] font-semibold tracking-[-0.025em]">
          Bugün ne üretelim?
        </h1>
        <p className="mt-2.5 max-w-[34rem] text-[1.02rem] leading-relaxed text-ink-2">
          {app.entities.length
            ? 'Hafızanızdaki kişi ve markaları @ ile çağırın; görsel, video, metin ve gönderi olarak geri dönsün.'
            : 'Kişilerinizi ve markanızı bir kez tanıtın; sonra her istekte @ ile çağırın. Bellek yüzleri, renkleri ve tercihleri unutmaz.'}
        </p>

        <div className="mt-7">
          <Composer draftKey="new" onSend={onSend} autoFocus />
        </div>

        {!ready && (
          <ol className="mt-6 grid gap-2.5 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title}>
                <Link
                  to={step.to}
                  className={cx(
                    'flex h-full gap-3 rounded-xl border p-3.5 transition-colors',
                    step.done ? 'border-line bg-sunken/60' : 'border-line bg-surface hover:border-line-strong',
                  )}
                >
                  <span
                    className={cx(
                      'grid h-6 w-6 flex-none place-items-center rounded-full font-mono text-[0.74rem] font-semibold',
                      step.done ? 'bg-ok-soft text-ok' : 'bg-ink text-bg',
                    )}
                  >
                    {step.done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className={cx('block text-[0.93rem] font-semibold', step.done && 'text-ink-3 line-through decoration-1')}>{step.title}</span>
                    <span className="mt-0.5 block text-[0.84rem] leading-snug text-ink-3">{step.body}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-6">
          <p className="mb-2 text-[0.82rem] font-medium text-ink-3">{app.entities.length ? 'Hafızanızdan fikirler' : 'Denemek için'}</p>
          <ul className="flex flex-col">
            {ideas.map((idea) => (
              <li key={idea.text} className="border-t border-line last:border-b">
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 py-2.5 text-left text-[0.95rem] text-ink-2 transition-colors hover:text-ink"
                  onClick={() => {
                    setMode(idea.mode);
                    setDraft('new', idea.text);
                    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="İstek"]')?.focus();
                  }}
                >
                  <span className="min-w-0 flex-1">{idea.text}</span>
                  <span className="meta flex-none opacity-0 transition-opacity group-hover:opacity-100">kullan</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function mergeMessages(detail: ConversationDetail, incoming: Message[]): ConversationDetail {
  const known = new Set(detail.messages.map((m) => m.id));
  const fresh = incoming.filter((m) => !known.has(m.id));
  return fresh.length ? { ...detail, messages: [...detail.messages, ...fresh] } : detail;
}

export function StudioPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const app = useApp();
  const conversation = useConversation(id);
  const detail = conversation.data;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [pendingBrand, setPendingBrand] = useState<string | null>(null);

  const brands = useMemo(() => app.entities.filter((e) => e.type === 'brand'), [app.entities]);
  const brand = brands.find((b) => b.id === (id ? detail?.brandId : pendingBrand)) ?? null;

  const send = useCallback(
    async (payload: SendPayload): Promise<boolean> => {
      try {
        let conversationId = id;
        if (!conversationId) {
          const created = await api.post<Conversation>('/api/conversations', { brandId: pendingBrand });
          conversationId = created.id;
          // Akış başlamadan önce önbelleği kur ki ilk parçalar kaçmasın.
          queryClient.setQueryData<ConversationDetail>(keys.conversation(created.id), {
            ...created, messages: [], jobs: [], posts: [], assets: [],
          });
        }
        const result = await api.post<{ user: Message; assistant: Message }>(`/api/conversations/${conversationId}/messages`, payload);
        queryClient.setQueryData<ConversationDetail>(keys.conversation(conversationId), (current) =>
          current ? mergeMessages(current, [result.user, result.assistant]) : current,
        );
        pinned.current = true;
        if (!id) {
          setPendingBrand(null);
          navigate(`/c/${conversationId}`);
        }
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : 'İstek gönderilemedi.', 'error');
        return false;
      }
    },
    [id, navigate, pendingBrand],
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      if (!id) return;
      const done = await attempt(() => api.post(`/api/messages/${messageId}/regenerate`));
      if (done) {
        pinned.current = true;
        await queryClient.invalidateQueries({ queryKey: keys.conversation(id) });
      }
    },
    [id],
  );

  // Kullanıcı en alttaysa yeni içerikle birlikte aşağıda kal; yukarı çıktıysa rahatsız etme.
  useLayoutEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner) return;
    const toBottom = () => {
      if (pinned.current) node.scrollTop = node.scrollHeight;
    };
    toBottom();
    const observer = new ResizeObserver(toBottom);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [id, !!detail]);

  useEffect(() => {
    pinned.current = true;
    setShowJump(false);
  }, [id]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinned.current = distance < 80;
    setShowJump(distance > 400);
  };

  if (!id) return <Welcome onSend={send} />;
  if (conversation.isLoading) return <PageLoader />;
  if (!detail) {
    return (
      <Empty
        className="pt-28"
        title="Bu sohbet bulunamadı"
        body="Silinmiş ya da taşınmış olabilir. Çöp kutusuna Ayarlar → Veri bölümünden ulaşabilirsiniz."
        action={<Link to="/" className="btn btn-primary">Yeni sohbet</Link>}
      />
    );
  }

  const streaming = [...detail.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'streaming');
  const lastAssistant = [...detail.messages].reverse().find((m) => m.role === 'assistant');

  const remove = async () => {
    await attempt(() => api.del(`/api/conversations/${detail.id}`));
    void refreshApp();
    navigate('/');
    toast('Sohbet çöp kutusuna taşındı.', 'info', {
      label: 'Geri al',
      run: () => void api.post('/api/trash/restore', { kind: 'conversation', id: detail.id }).then(refreshApp),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 flex-none items-center gap-2 border-b border-line px-6 max-md:px-4">
        <h1 className="min-w-0 flex-1 truncate text-[1rem] font-semibold">{detail.title || 'Yeni sohbet'}</h1>
        <BrandContext
          brand={brand}
          brands={brands}
          onChange={(brandId) => void attempt(() => api.patch(`/api/conversations/${detail.id}`, { brandId }))}
        />
        <Menu
          trigger={(props) => (
            <IconButton label="Sohbet seçenekleri" size="sm" {...props}>
              <MoreHorizontal />
            </IconButton>
          )}
          items={[
            {
              label: detail.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle',
              icon: detail.pinned ? <PinOff /> : <Pin />,
              onSelect: () => void attempt(() => api.patch(`/api/conversations/${detail.id}`, { pinned: !detail.pinned })),
            },
            'divider',
            { label: 'Çöp kutusuna taşı', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
          ]}
        />
      </header>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        <div ref={content} className="mx-auto flex w-full max-w-[50rem] flex-col gap-7 px-6 pt-7 pb-10 max-md:px-4">
          {detail.messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              entities={app.entities}
              posts={detail.posts}
              isLast={message.id === lastAssistant?.id}
              onRegenerate={regenerate}
            />
          ))}
        </div>
      </div>

      <div className="relative flex-none pb-5 max-md:pb-3">
        {showJump && (
          <button
            type="button"
            aria-label="Sona git"
            className="pop absolute -top-12 left-1/2 grid h-9 w-9 -translate-x-1/2 animate-rise place-items-center !rounded-full text-ink-2 hover:text-ink"
            onClick={() => {
              pinned.current = true;
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
            }}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
        <div className="mx-auto w-full max-w-[50rem] px-6 max-md:px-3">
          <Composer draftKey={detail.id} onSend={send} streamingId={streaming?.id ?? null} autoFocus />
        </div>
      </div>
    </div>
  );
}
