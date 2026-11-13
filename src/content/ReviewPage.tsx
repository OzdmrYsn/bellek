import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, MessageSquareWarning } from 'lucide-react';
import { useRef, useState } from 'react';
import { getFormat, getPlatform } from '../../shared/platforms.ts';
import type { ReviewView } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx, dateTime } from '../lib/format.ts';
import { Logo, Spinner } from '../ui/kit.tsx';

function Media({ view }: { view: ReviewView }) {
  const format = getFormat(view.post.platform, view.post.format);
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const media = view.post.media;

  const go = (next: number) => {
    const node = track.current;
    if (!node) return;
    node.scrollTo({ left: node.clientWidth * next, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  if (!media.length) {
    return (
      <div className="grid place-items-center bg-sunken text-[0.9rem] text-ink-3" style={{ aspectRatio: `${format.width} / ${format.height}` }}>
        Bu gönderide görsel yok
      </div>
    );
  }

  return (
    <div className="relative bg-sunken" style={{ aspectRatio: `${format.width} / ${format.height}` }}>
      <div
        ref={track}
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto [scrollbar-width:none]"
        onScroll={(event) => setIndex(Math.round(event.currentTarget.scrollLeft / Math.max(1, event.currentTarget.clientWidth)))}
      >
        {media.map((item, i) =>
          item.kind === 'video' ? (
            <video key={item.url} src={item.url} controls playsInline className="h-full w-full flex-none snap-center object-cover" />
          ) : (
            <img key={item.url} src={item.url} alt={`${i + 1}. görsel`} className="h-full w-full flex-none snap-center object-cover" />
          ),
        )}
      </div>
      {media.length > 1 && (
        <>
          <span className="absolute top-3 right-3 rounded-full bg-black/65 px-2 py-0.5 font-mono text-[0.72rem] text-white">
            {index + 1} / {media.length}
          </span>
          {index > 0 && (
            <button type="button" aria-label="Önceki görsel" onClick={() => go(index - 1)} className="absolute top-1/2 left-2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white hover:bg-black/75">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {index < media.length - 1 && (
            <button type="button" aria-label="Sonraki görsel" onClick={() => go(index + 1)} className="absolute top-1/2 right-2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white hover:bg-black/75">
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Müşterinin ya da ekip arkadaşının gördüğü onay sayfası. Hesap gerektirmez;
 * bağlantıdaki anahtar yalnızca bu tek gönderiyi açar.
 */
export function ReviewPage({ token }: { token: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['review', token], queryFn: () => api.get<ReviewView>(`/api/review/${token}`), retry: false, staleTime: Infinity });
  const [reviewer, setReviewer] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approved' | 'changes' | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  if (query.isLoading) {
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Spinner className="!h-5 !w-5" />
      </div>
    );
  }

  if (!query.data) {
    return (
      <div className="grid h-full place-items-center px-6">
        <div className="max-w-sm text-center">
          <Logo size={40} />
          <h1 className="mt-5 text-[1.2rem] font-semibold">Bu bağlantı artık geçerli değil</h1>
          <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-2">
            {query.error instanceof Error ? query.error.message : 'Onay bağlantısı kaldırılmış olabilir.'} Size gönderen kişiden yeni bir bağlantı isteyin.
          </p>
        </div>
      </div>
    );
  }

  const view = query.data;
  const { post, review } = view;
  const platform = getPlatform(post.platform);
  const format = getFormat(post.platform, post.format);
  const decided = review.status !== 'pending' && !editing;
  const narrow = format.height / format.width > 1.5;

  const decide = async (status: 'approved' | 'changes') => {
    if (status === 'changes' && !comment.trim()) {
      setError('Neyin değişmesini istediğinizi kısaca yazın.');
      commentRef.current?.focus();
      return;
    }
    setBusy(status);
    setError('');
    try {
      const next = await api.post<ReviewView>(`/api/review/${token}`, { status, reviewer, comment });
      client.setQueryData(['review', token], next);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Yanıtınız iletilemedi. Yeniden deneyin.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[62rem] gap-x-12 gap-y-8 px-6 py-10 max-md:px-4 max-md:py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className={cx('mx-auto w-full', narrow ? 'max-w-[20rem]' : 'max-w-[28rem]')}>
          <div className="overflow-hidden rounded-[18px] border border-line bg-surface shadow-card">
            <div className="flex items-center gap-2.5 px-4 py-3">
              <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-sunken text-[0.8rem] font-semibold text-ink-2">
                {(view.brandName ?? platform.label).slice(0, 1).toLocaleUpperCase('tr')}
              </span>
              <div className="min-w-0 leading-tight">
                <div className="truncate text-[0.9rem] font-semibold">{view.brandName ?? 'Gönderi'}</div>
                <div className="text-[0.76rem] text-ink-3">
                  {platform.label} · {format.label}
                </div>
              </div>
            </div>
            <Media view={view} />
            <div className="px-4 py-3.5 text-[0.93rem] leading-[1.55]">
              {post.caption ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{post.caption}</p> : <p className="text-ink-3">Metin henüz yazılmadı.</p>}
              {post.hashtags.length > 0 && <p className="mt-2 text-accent-text [overflow-wrap:anywhere]">{post.hashtags.join(' ')}</p>}
            </div>
          </div>
        </div>

        <div className="md:pt-2">
          <p className="text-[0.86rem] text-ink-3">{view.brandName ? `${view.brandName} · onay isteği` : 'Onay isteği'}</p>
          <h1 className="mt-1 text-[1.6rem] leading-tight font-semibold tracking-[-0.02em] [text-wrap:balance]">{post.title || `${platform.label} gönderisi`}</h1>
          <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-2">
            {post.scheduledAt ? `${dateTime(post.scheduledAt)} tarihinde yayınlanması planlanıyor.` : 'Yayın tarihi henüz belirlenmedi.'} Görseli ve metni inceleyin; uygunsa onaylayın, değilse neyin değişmesini istediğinizi yazın.
          </p>

          {decided ? (
            <div className="mt-7" aria-live="polite">
              <div className={cx('flex items-start gap-3 rounded-2xl px-4 py-4', review.status === 'approved' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')}>
                <span className="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-current">
                  {review.status === 'approved' ? <Check className="h-3.5 w-3.5 text-bg" strokeWidth={3.5} /> : <MessageSquareWarning className="h-3.5 w-3.5 text-bg" />}
                </span>
                <div className="min-w-0">
                  <p className="text-[1rem] font-semibold">{review.status === 'approved' ? 'Onayınız iletildi' : 'Düzeltme isteğiniz iletildi'}</p>
                  {review.comment && <p className="mt-1 text-[0.93rem] leading-relaxed whitespace-pre-wrap text-ink">“{review.comment}”</p>}
                  <p className="mt-1 text-[0.84rem] text-ink-2">
                    {review.reviewer ? `${review.reviewer} · ` : ''}
                    {review.decidedAt ? dateTime(review.decidedAt) : ''}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm mt-3"
                onClick={() => {
                  setReviewer(review.reviewer);
                  setComment(review.comment);
                  setEditing(true);
                }}
              >
                Yanıtımı değiştir
              </button>
            </div>
          ) : (
            <form className="mt-7 flex flex-col gap-3.5" onSubmit={(event) => event.preventDefault()}>
              <label className="block">
                <span className="label">Adınız</span>
                <input className="input" placeholder="Kimin yanıtladığı görünsün" autoComplete="name" value={reviewer} onChange={(event) => setReviewer(event.target.value)} maxLength={80} />
              </label>
              <label className="block">
                <span className="label">Notunuz</span>
                <textarea
                  ref={commentRef}
                  className="input"
                  rows={4}
                  placeholder="Onaylarken isteğe bağlı; düzeltme isterken neyin değişeceğini yazın."
                  aria-invalid={!!error}
                  value={comment}
                  onChange={(event) => {
                    setComment(event.target.value);
                    setError('');
                  }}
                  maxLength={2000}
                />
              </label>
              {error && <p className="text-[0.86rem] text-danger" role="alert">{error}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" className="btn btn-primary min-w-36 flex-1" disabled={!!busy} onClick={() => void decide('approved')}>
                  {busy === 'approved' ? <Spinner /> : <Check />} Onayla
                </button>
                <button type="button" className="btn btn-outline min-w-36 flex-1" disabled={!!busy} onClick={() => void decide('changes')}>
                  {busy === 'changes' ? <Spinner /> : <MessageSquareWarning />} Düzeltme iste
                </button>
              </div>
            </form>
          )}

          <p className="mt-9 flex items-center gap-2 text-[0.8rem] text-ink-3">
            <Logo size={16} /> Bellek ile hazırlandı. Bu sayfa yalnızca bu gönderiyi gösterir.
          </p>
        </div>
      </div>
    </div>
  );
}
