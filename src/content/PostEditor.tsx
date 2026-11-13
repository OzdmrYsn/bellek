import {
  ArrowLeft, Check, Copy, Download, FolderOpen, Hash, ImagePlus, LayoutTemplate, MoreHorizontal, Sparkles, Trash2,
  Wand2, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { POST_STATUSES, PLATFORMS, getFormat, getPlatform } from '../../shared/platforms.ts';
import type { Entity, Post, PostStatus } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { copyText, cx, toLocalInput } from '../lib/format.ts';
import { keys, queryClient, useApp, usePost } from '../lib/queries.ts';
import { attempt, pickAssets, toast, useUI } from '../lib/store.ts';
import { downloadAsset, useAssetActions } from '../library/actions.ts';
import { MentionInput } from '../studio/MentionInput.tsx';
import { fullCaption, generatePostImage, usePostJobActive } from '../studio/PostCard.tsx';
import { Avatar, Empty, Field, IconButton, PageLoader, PlatformBadge, Spinner } from '../ui/kit.tsx';
import { Menu } from '../ui/Popover.tsx';
import { CarouselSection, ResultsSection, ReviewSection } from './PostExtras.tsx';

const REWRITES: { label: string; instruction: string }[] = [
  { label: 'Güçlendir', instruction: 'Make the first line stop the scroll and tighten everything after it.' },
  { label: 'Kısalt', instruction: 'Cut it to roughly half the length without losing the key message.' },
  { label: 'Daha samimi', instruction: 'Make it warmer and more conversational, like a person talking, not a brand.' },
  { label: 'Daha kurumsal', instruction: 'Make it more polished and professional while staying human.' },
  { label: 'Çağrı ekle', instruction: 'End with one clear, specific call to action.' },
];

function Preview({ post, brand, caption, hashtags }: { post: Post; brand: Entity | null; caption: string; hashtags: string }) {
  const platform = getPlatform(post.platform);
  const format = getFormat(post.platform, post.format);
  const [expanded, setExpanded] = useState(false);
  const [index, setIndex] = useState(0);
  const cover = post.assets[Math.min(index, post.assets.length - 1)];
  const long = caption.length > 180;
  const shown = expanded || !long ? caption : `${caption.slice(0, 180).trimEnd()}…`;
  const generating = usePostJobActive(post.id);
  const narrow = format.height / format.width > 1.5;

  return (
    <div className={cx('mx-auto w-full overflow-hidden rounded-[18px] border border-line bg-surface shadow-card', narrow ? 'max-w-[17.5rem]' : 'max-w-[23rem]')}>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        {brand ? <Avatar entity={brand} size={30} /> : <span className="h-[30px] w-[30px] rounded-full bg-sunken" />}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[0.86rem] font-semibold">{brand?.name ?? 'Hesap adı'}</div>
          <div className="text-[0.72rem] text-ink-3">{platform.label} önizlemesi</div>
        </div>
        <MoreHorizontal className="h-4 w-4 text-ink-3" />
      </div>
      <div className="relative bg-sunken" style={{ aspectRatio: `${format.width} / ${format.height}` }}>
        {cover ? (
          cover.kind === 'video' ? (
            <video key={cover.id} src={cover.url} poster={cover.thumbUrl || undefined} controls playsInline className="h-full w-full object-cover" />
          ) : (
            <img key={cover.id} src={cover.url} alt="" className="h-full w-full object-cover" />
          )
        ) : (
          <div className={cx('grid h-full w-full place-items-center', generating && 'exposing')}>
            <span className="text-[0.84rem] text-ink-3">{generating ? 'Görsel üretiliyor' : 'Görsel eklenmedi'}</span>
          </div>
        )}
        {post.assets.length > 1 && (
          <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1">
            {post.assets.map((asset, i) => (
              <button
                key={asset.id}
                type="button"
                aria-label={`${i + 1}. görsel`}
                onClick={() => setIndex(i)}
                className={cx('h-1.5 w-1.5 rounded-full transition-colors', i === index ? 'bg-white' : 'bg-white/50')}
              />
            ))}
          </div>
        )}
      </div>
      <div className="px-3.5 py-3 text-[0.86rem] leading-[1.5]">
        {caption ? (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            <span className="font-semibold">{brand?.handle ?? 'hesap'} </span>
            {shown}
            {long && !expanded && (
              <button type="button" className="ml-1 text-ink-3" onClick={() => setExpanded(true)}>
                devamı
              </button>
            )}
          </p>
        ) : (
          <p className="text-ink-3">Metin burada görünecek.</p>
        )}
        {hashtags.trim() && <p className="mt-1.5 text-accent-text [overflow-wrap:anywhere]">{hashtags}</p>}
      </div>
    </div>
  );
}

function Checklist({ post, caption, tagCount }: { post: Post; caption: string; tagCount: number }) {
  const platform = getPlatform(post.platform);
  const checks = [
    { ok: caption.trim().length > 0 && caption.length <= platform.captionLimit, label: caption.length > platform.captionLimit ? `Metin ${caption.length - platform.captionLimit} karakter fazla` : caption.trim() ? 'Metin sınırın içinde' : 'Metin yazılmadı' },
    { ok: post.assets.length > 0, label: post.assets.length ? `${post.assets.length} görsel eklendi` : 'Görsel eklenmedi' },
    { ok: tagCount <= platform.hashtagLimit, label: tagCount > platform.hashtagLimit ? `${platform.label} için en fazla ${platform.hashtagLimit} etiket önerilir` : `${tagCount} etiket` },
    { ok: !!post.scheduledAt, label: post.scheduledAt ? 'Tarih verildi' : 'Tarih verilmedi' },
  ];
  return (
    <ul className="mx-auto mt-5 flex w-full max-w-[23rem] flex-col gap-1.5">
      {checks.map((item) => (
        <li key={item.label} className={cx('flex items-center gap-2 text-[0.84rem]', item.ok ? 'text-ink-2' : 'text-ink-3')}>
          <span className={cx('grid h-4 w-4 flex-none place-items-center rounded-full', item.ok ? 'bg-ok-soft text-ok' : 'border border-line-strong')}>
            {item.ok && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
          </span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function PostEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const app = useApp();
  const query = usePost(id);
  const post = query.data;
  const act = useAssetActions();
  const openLightbox = useUI((s) => s.openLightbox);
  const generating = usePostJobActive(id ?? '');

  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [prompt, setPrompt] = useState('');
  const [notes, setNotes] = useState('');
  const [custom, setCustom] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);
  const timer = useRef(0);
  const pendingPatch = useRef<Record<string, unknown>>({});

  // Metin alanları yerelde tutulur; gönderi ilk yüklendiğinde bir kez doldurulur.
  useEffect(() => {
    if (!post || loaded.current === post.id) return;
    loaded.current = post.id;
    setTitle(post.title);
    setCaption(post.caption);
    setHashtags(post.hashtags.join(' '));
    setPrompt(post.imagePrompt);
    setNotes(post.notes);
  }, [post]);

  const flush = async () => {
    window.clearTimeout(timer.current);
    const patch = pendingPatch.current;
    pendingPatch.current = {};
    if (!id || !Object.keys(patch).length) return;
    setSaveState('saving');
    const next = await attempt(() => api.patch<Post>(`/api/posts/${id}`, patch));
    if (next) queryClient.setQueryData(keys.post(id), next);
    setSaveState(next ? 'saved' : 'idle');
  };

  const queue = (patch: Record<string, unknown>) => {
    // `data` alt alanları (kareler, sonuçlar) birbirini ezmesin diye ayrıca birleştirilir.
    const data = patch.data ? { ...(pendingPatch.current.data as object | undefined), ...(patch.data as object) } : pendingPatch.current.data;
    pendingPatch.current = { ...pendingPatch.current, ...patch, ...(data ? { data } : {}) };
    setSaveState('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 650);
  };

  // Sayfadan çıkarken bekleyen değişiklikleri kaydet.
  useEffect(() => () => void flush(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchNow = async (patch: Record<string, unknown>) => {
    if (!id) return;
    const next = await attempt(() => api.patch<Post>(`/api/posts/${id}`, patch));
    if (next) queryClient.setQueryData(keys.post(id), next);
  };

  if (query.isLoading) return <PageLoader />;
  if (!post) {
    return (
      <Empty className="pt-28" title="Gönderi bulunamadı" body="Silinmiş olabilir. Çöp kutusuna Ayarlar → Veri bölümünden ulaşabilirsiniz." action={<Link to="/icerik" className="btn btn-primary">İçeriğe dön</Link>} />
    );
  }

  const platform = getPlatform(post.platform);
  const brands = app.entities.filter((e) => e.type === 'brand');
  const brand = brands.find((b) => b.id === post.brandId) ?? null;
  const tagCount = hashtags.split(/\s+/).filter(Boolean).length;
  const hasText = app.models.some((m) => m.model.kind === 'text');
  const over = caption.length > platform.captionLimit;
  const showResults = post.status === 'published' || Object.keys(post.data.metrics ?? {}).length > 0;

  const rewrite = async (label: string, instruction: string) => {
    setAiBusy(label);
    const previous = caption;
    const result = await attempt(() => api.post<{ caption: string }>(`/api/posts/${post.id}/caption`, { instruction, draft: caption }));
    setAiBusy(null);
    if (!result) return;
    setCaption(result.caption);
    queue({ caption: result.caption });
    toast('Metin yeniden yazıldı.', 'ok', {
      label: 'Geri al',
      run: () => {
        setCaption(previous);
        queue({ caption: previous });
      },
    });
  };

  const suggestTags = async () => {
    setAiBusy('tags');
    const result = await attempt(() => api.post<{ hashtags: string[] }>(`/api/posts/${post.id}/hashtags`, { draft: caption }));
    setAiBusy(null);
    if (!result) return;
    const merged = [...new Set([...hashtags.split(/\s+/).filter(Boolean), ...result.hashtags])].join(' ');
    setHashtags(merged);
    queue({ hashtags: merged });
  };

  const addMedia = async () => {
    const ids = await pickAssets({ title: 'Gönderiye medya ekle', multiple: true });
    if (ids.length) await patchNow({ assetIds: [...post.assetIds, ...ids] });
  };

  const generate = async () => {
    await flush();
    const fresh = queryClient.getQueryData<Post>(keys.post(post.id)) ?? post;
    await generatePostImage(fresh);
  };

  const remove = async () => {
    await attempt(() => api.del(`/api/posts/${post.id}`));
    void queryClient.invalidateQueries({ queryKey: ['posts'] });
    navigate('/icerik');
    toast('Gönderi çöp kutusuna taşındı.', 'info', {
      label: 'Geri al',
      run: () => void api.post('/api/trash/restore', { kind: 'post', id: post.id }).then(() => queryClient.invalidateQueries({ queryKey: ['posts'] })),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 flex-none items-center gap-2 border-b border-line px-4">
        <Link to="/icerik" className="btn btn-ghost btn-sm">
          <ArrowLeft /> İçerik
        </Link>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[0.8rem] text-ink-3" aria-live="polite">
          {saveState === 'saving' && <><Spinner className="!h-3 !w-3" /> Kaydediliyor</>}
          {saveState === 'saved' && <><Check className="h-3.5 w-3.5 text-ok" /> Kaydedildi</>}
        </span>
        <button type="button" className="btn btn-outline btn-sm" onClick={async () => (await copyText(fullCaption({ caption, hashtags: hashtags.split(/\s+/).filter(Boolean) }))) && toast('Metin ve etiketler kopyalandı.', 'ok')}>
          <Copy /> Metni kopyala
        </button>
        <Menu
          trigger={(props) => (
            <IconButton label="Diğer" size="sm" {...props}>
              <MoreHorizontal />
            </IconButton>
          )}
          items={[
            { label: 'Medyayı indir', icon: <Download />, onSelect: () => post.assets.forEach(downloadAsset), hidden: !post.assets.length },
            { label: 'Tasarımı düzenle', icon: <LayoutTemplate />, onSelect: () => navigate(`/tasarim/${post.designId}`), hidden: !post.designId },
            { label: post.designId ? 'Görselden yeni tasarım' : 'Tasarım editöründe aç', icon: <LayoutTemplate />, onSelect: () => post.assets[0] && void act.toDesign(post.assets[0]), hidden: post.assets[0]?.kind !== 'image' },
            'divider',
            { label: 'Çöp kutusuna taşı', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
          ]}
        />
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_27rem]">
        <div className="min-h-0 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-6 py-6 max-md:px-4">
            <input
              className="-mx-2 w-[calc(100%+1rem)] rounded-lg bg-transparent px-2 py-1 text-[1.5rem] font-semibold tracking-[-0.02em] outline-none placeholder:text-ink-3 hover:bg-sunken focus:bg-sunken"
              placeholder="Gönderi başlığı (yalnızca sizin için)"
              aria-label="Başlık"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                queue({ title: event.target.value });
              }}
            />

            <div className="grid gap-3.5 sm:grid-cols-3">
              <Field label="Platform">
                <select className="input" value={post.platform} onChange={(event) => void patchNow({ platform: event.target.value, format: getPlatform(event.target.value).formats[0].id })}>
                  {PLATFORMS.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Biçim">
                <select className="input" value={post.format} onChange={(event) => void patchNow({ format: event.target.value })}>
                  {platform.formats.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Marka">
                <select className="input" value={post.brandId ?? ''} onChange={(event) => void patchNow({ brandId: event.target.value || null })}>
                  <option value="">Marka yok</option>
                  {brands.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div>
              <div className="mb-1.5 flex items-end justify-between">
                <span className="label !mb-0">Metin</span>
                <span className={cx('meta', over && '!text-danger')}>
                  {caption.length} / {platform.captionLimit}
                </span>
              </div>
              <textarea
                className="input min-h-44"
                rows={8}
                aria-label="Gönderi metni"
                aria-invalid={over}
                placeholder="Gönderi metnini yazın ya da aşağıdan yapay zekâya yazdırın."
                value={caption}
                onChange={(event) => {
                  setCaption(event.target.value);
                  queue({ caption: event.target.value });
                }}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Wand2 className="h-4 w-4 flex-none text-ink-3" />
                {REWRITES.map((item) => (
                  <button key={item.label} type="button" className="chip !h-7" disabled={!!aiBusy || !hasText} onClick={() => void rewrite(item.label, item.instruction)}>
                    {aiBusy === item.label && <Spinner className="!h-3 !w-3" />}
                    {caption.trim() || item.label !== 'Güçlendir' ? item.label : 'Yaz'}
                  </button>
                ))}
                <form
                  className="flex min-w-48 flex-1 gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (custom.trim()) void rewrite('custom', custom.trim()).then(() => setCustom(''));
                  }}
                >
                  <input className="input !h-7 !rounded-full !text-[0.82rem]" placeholder="Kendi yönergeniz: “bayram temalı yap”" aria-label="Yeniden yazma yönergesi" value={custom} onChange={(event) => setCustom(event.target.value)} disabled={!hasText} />
                  {custom.trim() && (
                    <button type="submit" className="btn btn-primary btn-sm !h-7 !rounded-full" disabled={!!aiBusy}>
                      {aiBusy === 'custom' ? <Spinner /> : 'Uygula'}
                    </button>
                  )}
                </form>
              </div>
              {!hasText && <p className="hint mt-1.5">Yapay zekâ araçları için Ayarlar'dan bir metin modeli bağlayın.</p>}
            </div>

            <div>
              <div className="mb-1.5 flex items-end justify-between">
                <span className="label !mb-0">Etiketler</span>
                <button type="button" className="btn btn-ghost btn-sm !h-7" disabled={!!aiBusy || !hasText} onClick={suggestTags}>
                  {aiBusy === 'tags' ? <Spinner /> : <Hash />} Öner
                </button>
              </div>
              <input
                className="input"
                aria-label="Etiketler"
                placeholder="#etiket #ekleyin"
                value={hashtags}
                onChange={(event) => {
                  setHashtags(event.target.value);
                  queue({ hashtags: event.target.value });
                }}
              />
            </div>

            <div>
              <div className="mb-2 flex items-end justify-between">
                <span className="label !mb-0">Medya</span>
                <button type="button" className="btn btn-ghost btn-sm !h-7" onClick={addMedia}>
                  <FolderOpen /> Kütüphaneden ekle
                </button>
              </div>
              {(post.assets.length > 0 || generating) && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {post.assets.map((asset, index) => (
                    <span key={asset.id} className="group/m relative h-24 w-24 overflow-hidden rounded-xl bg-sunken">
                      <button type="button" className="block h-full w-full" onClick={() => openLightbox(post.assetIds, index)} aria-label="Büyüt">
                        <img src={asset.thumbUrl || asset.url} alt="" className="h-full w-full object-cover" />
                      </button>
                      <button
                        type="button"
                        aria-label="Gönderiden çıkar"
                        onClick={() => void patchNow({ assetIds: post.assetIds.filter((x) => x !== asset.id) })}
                        className="absolute top-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white opacity-0 group-hover/m:opacity-100 focus-visible:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {generating && <span className="exposing grid h-24 w-24 place-items-center rounded-xl text-[0.74rem] text-ink-2">Üretiliyor</span>}
                </div>
              )}
              <div className="rounded-xl border border-line bg-surface focus-within:border-line-strong">
                <MentionInput
                  ariaLabel="Görsel istemi"
                  value={prompt}
                  onChange={(value) => {
                    setPrompt(value);
                    queue({ imagePrompt: value });
                  }}
                  entities={app.entities}
                  minHeight={72}
                  maxHeight={200}
                  menuSide="top"
                  placeholder="Görseli anlatın. Kişi ya da logo referansı için @ ile anın."
                  className="px-3.5 pt-3 pb-1 text-[0.93rem] leading-relaxed"
                />
                <div className="flex items-center justify-between gap-2 p-2">
                  <span className="hint pl-1.5">
                    {getFormat(post.platform, post.format).aspect} · {brand ? `${brand.name} paleti eklenir` : 'marka seçilmedi'}
                  </span>
                  <button type="button" className="btn btn-accent btn-sm" disabled={!prompt.trim() || generating} onClick={generate}>
                    {generating ? <Spinner /> : post.assets.length ? <Sparkles /> : <ImagePlus />}
                    {post.assets.length ? 'Yeni görsel üret' : 'Görseli üret'}
                  </button>
                </div>
              </div>
            </div>

            <CarouselSection post={post} brand={brand} hasText={hasText} queue={queue} flush={flush} />

            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Yayın tarihi" hint="Tarih verince gönderi takvime düşer.">
                <input
                  type="datetime-local"
                  className="input"
                  value={toLocalInput(post.scheduledAt)}
                  onChange={(event) => void patchNow({ scheduledAt: event.target.value ? new Date(event.target.value).toISOString() : null })}
                />
              </Field>
              <Field label="Durum" hint={showResults ? undefined : '“Yayınlandı” yapınca sonuç alanları açılır.'}>
                <select className="input" value={post.status} onChange={(event) => void patchNow({ status: event.target.value as PostStatus })}>
                  {POST_STATUSES.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            {showResults && <ResultsSection post={post} queue={queue} flush={flush} hasText={hasText} />}

            <ReviewSection post={post} local={app.app.local} flush={flush} />

            <Field label="Ekip notu">
              <textarea
                className="input"
                rows={2}
                placeholder="Onay bekleyenler, bağlantılar, hatırlatmalar…"
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value);
                  queue({ notes: event.target.value });
                }}
              />
            </Field>
          </div>
        </div>

        <aside className="min-h-0 overflow-y-auto border-l border-line bg-sunken px-6 py-7 max-lg:border-t max-lg:border-l-0">
          <div className="mb-4 flex items-center justify-center gap-2 text-[0.82rem] text-ink-3">
            <PlatformBadge platform={post.platform} /> {platform.label} · {getFormat(post.platform, post.format).label}
          </div>
          <Preview post={post} brand={brand} caption={caption} hashtags={hashtags} />
          <Checklist post={post} caption={caption} tagCount={tagCount} />
        </aside>
      </div>
    </div>
  );
}
