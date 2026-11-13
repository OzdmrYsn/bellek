import { ArrowDown, ArrowUp, Check, Copy, GalleryHorizontalEnd, Lightbulb, Link2, Plus, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Entity, MemorySuggestion, Post, PostMetrics, Slide } from '../../shared/types.ts';
import { renderSlides, sourcePhoto } from '../design/batch.ts';
import { api } from '../lib/api.ts';
import { copyText, cx, dateTime } from '../lib/format.ts';
import { keys, queryClient } from '../lib/queries.ts';
import { attempt, toast } from '../lib/store.ts';
import { SuggestionDialog } from '../memory/SuggestionDialog.tsx';
import { IconButton, Notice, Spinner, Switch } from '../ui/kit.tsx';
import { REVIEW_LABEL } from './PostsPage.tsx';

type Queue = (patch: Record<string, unknown>) => void;

// ───────────────────────── Kaydırmalı gönderi ─────────────────────────

interface CarouselProps {
  post: Post;
  brand: Entity | null;
  hasText: boolean;
  queue: Queue;
  flush: () => Promise<void>;
}

export function CarouselSection({ post, brand, hasText, queue, flush }: CarouselProps) {
  const [slides, setSlides] = useState<Slide[]>(post.data.slides ?? []);
  const [count, setCount] = useState(5);
  const [topic, setTopic] = useState('');
  const [writing, setWriting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cover, setCover] = useState(true);
  const photo = sourcePhoto(post);

  useEffect(() => setSlides(post.data.slides ?? []), [post.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (next: Slide[]) => {
    setSlides(next);
    queue({ data: { slides: next } });
  };
  const edit = (index: number, patch: Partial<Slide>) => change(slides.map((slide, i) => (i === index ? { ...slide, ...patch } : slide)));
  const move = (index: number, step: number) => {
    const next = [...slides];
    const [item] = next.splice(index, 1);
    next.splice(index + step, 0, item);
    change(next);
  };

  const write = async () => {
    setWriting(true);
    await flush();
    const next = await attempt(() => api.post<Post>(`/api/posts/${post.id}/slides`, { count, topic }));
    setWriting(false);
    if (!next) return;
    queryClient.setQueryData(keys.post(post.id), next);
    setSlides(next.data.slides ?? []);
  };

  const render = async () => {
    await flush();
    const fresh = queryClient.getQueryData<Post>(keys.post(post.id)) ?? post;
    const previous = fresh.assetIds;
    setProgress({ done: 0, total: slides.length });
    try {
      const next = await renderSlides({ ...fresh, data: { ...fresh.data, slides } }, brand, {
        coverPhotoId: cover && photo ? photo.id : null,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      toast(
        `${next.assetIds.length} kare görsele çevrildi ve gönderinin medyası oldu.`,
        'ok',
        previous.length
          ? {
              label: 'Geri al',
              run: () => void api.patch<Post>(`/api/posts/${post.id}`, { assetIds: previous }).then((restored) => queryClient.setQueryData(keys.post(post.id), restored)),
            }
          : undefined,
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Kareler oluşturulamadı.', 'error');
    } finally {
      setProgress(null);
    }
  };

  const filled = slides.filter((slide) => slide.headline.trim() || slide.body.trim()).length;

  return (
    <section aria-label="Kaydırmalı gönderi">
      <div className="mb-2 flex items-end justify-between gap-3">
        <span className="label !mb-0 flex items-center gap-1.5">
          <GalleryHorizontalEnd className="h-4 w-4 text-ink-3" /> Kaydırmalı gönderi
        </span>
        {slides.length > 0 && <span className="meta">{slides.length} kare</span>}
      </div>

      {slides.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-4">
          <p className="text-[0.9rem] leading-relaxed text-ink-2">
            Konuyu kare kare anlatın: ilk kare durdurur, sonuncusu harekete geçirir. Kareler marka renkleriniz ve yazı tipinizle görsele çevrilir.
          </p>
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void write();
            }}
          >
            <input
              className="input !h-9 min-w-48 flex-1"
              placeholder="Konu (boşsa gönderi metninden çıkarılır)"
              aria-label="Kaydırmalı gönderinin konusu"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              disabled={!hasText}
            />
            <select className="input !h-9 !w-auto" value={count} onChange={(event) => setCount(Number(event.target.value))} aria-label="Kare sayısı" disabled={!hasText}>
              {[3, 4, 5, 6, 7, 8, 10].map((n) => (
                <option key={n} value={n}>{n} kare</option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary btn-sm !h-9" disabled={writing || !hasText}>
              {writing ? <Spinner /> : <Wand2 />} {writing ? 'Yazılıyor…' : 'Yapay zekâyla yaz'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm !h-9" onClick={() => change([{ headline: '', body: '' }])}>
              Elle başla
            </button>
          </form>
        </div>
      ) : (
        <>
          <ol className="flex flex-col gap-2">
            {slides.map((slide, index) => (
              <li key={index} className="group/s flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 focus-within:border-line-strong">
                <span className="mt-1.5 w-5 flex-none text-center font-mono text-[0.78rem] text-ink-3">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <input
                    className="block w-full bg-transparent text-[0.98rem] font-semibold outline-none placeholder:font-normal placeholder:text-ink-3"
                    placeholder={index === 0 ? 'Kapak başlığı' : 'Başlık'}
                    aria-label={`${index + 1}. kare başlığı`}
                    value={slide.headline}
                    onChange={(event) => edit(index, { headline: event.target.value })}
                  />
                  <textarea
                    className="mt-0.5 block w-full resize-none bg-transparent text-[0.9rem] leading-relaxed text-ink-2 outline-none [field-sizing:content] placeholder:text-ink-3"
                    rows={1}
                    placeholder="Açıklama (isteğe bağlı)"
                    aria-label={`${index + 1}. kare metni`}
                    value={slide.body}
                    onChange={(event) => edit(index, { body: event.target.value })}
                  />
                </div>
                <div className="flex flex-none items-center opacity-0 transition-opacity group-focus-within/s:opacity-100 group-hover/s:opacity-100 max-md:opacity-100">
                  <IconButton label="Yukarı taşı" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp />
                  </IconButton>
                  <IconButton label="Aşağı taşı" size="sm" disabled={index === slides.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown />
                  </IconButton>
                  <IconButton label="Kareyi sil" size="sm" onClick={() => change(slides.filter((_, i) => i !== index))}>
                    <Trash2 />
                  </IconButton>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
            <button type="button" className="btn btn-ghost btn-sm" disabled={slides.length >= 10} onClick={() => change([...slides, { headline: '', body: '' }])}>
              <Plus /> Kare ekle
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={writing || !hasText} onClick={write} title="Kareleri baştan yazdırır">
              {writing ? <Spinner /> : <Wand2 />} Yeniden yazdır
            </button>
            <span className="flex-1" />
            {photo && (
              <label className="flex items-center gap-2 text-[0.84rem] text-ink-2">
                Kapakta fotoğrafı kullan
                <Switch checked={cover} label="Kapakta gönderinin fotoğrafını kullan" onChange={setCover} />
              </label>
            )}
            <button type="button" className="btn btn-accent btn-sm" disabled={!!progress || !filled} onClick={render}>
              {progress ? <Spinner /> : <GalleryHorizontalEnd />}
              {progress ? `Çiziliyor ${Math.min(progress.done + 1, progress.total)} / ${progress.total}` : 'Kareleri görsele çevir'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ───────────────────────── Yayın sonuçları ─────────────────────────

const METRICS: { key: keyof PostMetrics; label: string }[] = [
  { key: 'reach', label: 'Erişim' },
  { key: 'likes', label: 'Beğeni' },
  { key: 'comments', label: 'Yorum' },
  { key: 'saves', label: 'Kaydetme' },
  { key: 'shares', label: 'Paylaşım' },
  { key: 'clicks', label: 'Tıklama' },
];

function toText(metrics: PostMetrics | undefined): Record<string, string> {
  return Object.fromEntries(METRICS.map(({ key }) => [key, metrics?.[key] !== undefined ? String(metrics[key]) : '']));
}

export function ResultsSection({ post, queue, flush, hasText }: { post: Post; queue: Queue; flush: () => Promise<void>; hasText: boolean }) {
  const [values, setValues] = useState(() => toText(post.data.metrics));
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<MemorySuggestion[] | null>(null);

  useEffect(() => setValues(toText(post.data.metrics)), [post.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key: string, raw: string) => {
    const next = { ...values, [key]: raw.replace(/[^\d]/g, '').slice(0, 10) };
    setValues(next);
    queue({ data: { metrics: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '').map(([k, value]) => [k, Number(value)])) } });
  };

  const learn = async () => {
    setBusy(true);
    await flush();
    const found = await attempt(() => api.post<MemorySuggestion[]>('/api/posts/insights', { brandId: post.brandId }));
    setBusy(false);
    if (found) setSuggestions(found);
  };

  const reach = Number(values.reach) || 0;
  const engaged = ['likes', 'comments', 'saves', 'shares'].reduce((sum, key) => sum + (Number(values[key]) || 0), 0);

  return (
    <section aria-label="Yayın sonuçları">
      <div className="mb-2 flex items-end justify-between gap-3">
        <span className="label !mb-0">Yayın sonuçları</span>
        {reach > 0 && engaged > 0 && <span className="meta">%{((engaged / reach) * 100).toFixed(1).replace('.', ',')} etkileşim</span>}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {METRICS.map(({ key, label }) => (
          <label key={key} className="block">
            <span className="mb-1 block text-[0.78rem] text-ink-3">{label}</span>
            <input
              className="input !h-9 !px-2.5 text-right font-mono !text-[0.86rem] tabular-nums"
              inputMode="numeric"
              placeholder="—"
              value={values[key] ?? ''}
              onChange={(event) => set(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="hint max-w-[30rem]">Sayıları platformun istatistik ekranından girin. Birkaç gönderi birikince Bellek neyin işe yaradığını çıkarır ve sonraki içeriklerde kullanır.</p>
        <button type="button" className="btn btn-outline btn-sm" disabled={busy || !hasText} onClick={learn}>
          {busy ? <Spinner /> : <Lightbulb />} İçgörü çıkar
        </button>
      </div>
      <SuggestionDialog
        suggestions={suggestions}
        onClose={() => setSuggestions(null)}
        title="Sonuçlardan çıkan dersler"
        description="Girdiğiniz sonuçlara göre işe yarayan ve yaramayan örüntüler. İşaretledikleriniz hafızaya eklenir ve sonraki gönderilerde dikkate alınır."
        entityId={post.brandId}
      />
    </section>
  );
}

// ───────────────────────── Onay bağlantısı ─────────────────────────

export function ReviewSection({ post, local, flush }: { post: Post; local: boolean; flush: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const review = post.review;
  const url = review ? `${window.location.origin}/onay/${review.token}` : '';

  const call = async (run: () => Promise<Post>) => {
    setBusy(true);
    await flush();
    const next = await attempt(run);
    setBusy(false);
    if (next) queryClient.setQueryData(keys.post(post.id), next);
    return next;
  };

  const open = async () => {
    const next = await call(() => api.post<Post>(`/api/posts/${post.id}/review`));
    if (next?.review && (await copyText(`${window.location.origin}/onay/${next.review.token}`))) toast('Onay bağlantısı oluşturuldu ve kopyalandı.', 'ok');
  };

  return (
    <section aria-label="Onay">
      <div className="mb-2 flex items-end justify-between gap-3">
        <span className="label !mb-0">Onay</span>
        {review && (
          <span className={cx('text-[0.8rem] font-medium', review.status === 'approved' ? 'text-ok' : review.status === 'changes' ? 'text-warn' : 'text-ink-3')}>
            {REVIEW_LABEL[review.status]}
          </span>
        )}
      </div>

      {!review ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
          <p className="hint max-w-[30rem]">Müşteriniz ya da ekibiniz gönderiyi hesap açmadan görür; onaylar ya da ne değişsin yazar. Bağlantı yalnızca bu gönderiyi gösterir.</p>
          <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={open}>
            {busy ? <Spinner /> : <Link2 />} Onay bağlantısı oluştur
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {review.status !== 'pending' && (
            <Notice level={review.status === 'approved' ? 'ok' : 'warn'}>
              <span className="font-medium">
                {review.reviewer || 'İnceleyen kişi'} {review.status === 'approved' ? 'onayladı' : 'düzeltme istedi'}
              </span>
              {review.decidedAt && <span className="opacity-80"> · {dateTime(review.decidedAt)}</span>}
              {review.comment && <p className="mt-1 whitespace-pre-wrap text-ink">“{review.comment}”</p>}
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input className="input !h-9 min-w-56 flex-1 font-mono !text-[0.8rem]" readOnly aria-label="Onay bağlantısı" value={url} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="btn btn-outline btn-sm !h-9" onClick={async () => (await copyText(url)) && toast('Bağlantı kopyalandı.', 'ok')}>
              <Copy /> Kopyala
            </button>
            {review.status !== 'pending' && (
              <button type="button" className="btn btn-outline btn-sm !h-9" disabled={busy} onClick={open} title="Düzelttikten sonra yeni bir bağlantıyla yeniden onaya gönderin">
                <Check /> Yeniden gönder
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm !h-9" disabled={busy} onClick={() => void call(() => api.del<Post>(`/api/posts/${post.id}/review`))}>
              Bağlantıyı kapat
            </button>
          </div>
          {local && (
            <p className="hint">
              Bellek şu an yalnızca bu bilgisayardan açılıyor; bu bağlantı da öyle. Başkasına göndermek için Bellek'i ağa açın: README'deki “Onay bağlantısını paylaşmak” bölümüne bakın.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
