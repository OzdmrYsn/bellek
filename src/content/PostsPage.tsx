import { GalleryHorizontalEnd, LayoutTemplate, Megaphone, Newspaper, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { POST_STATUSES, getPlatform } from '../../shared/platforms.ts';
import type { Campaign, Post, PostStatus, ReviewStatus } from '../../shared/types.ts';
import { applyLayout, needsLayout } from '../design/batch.ts';
import { TEMPLATES } from '../design/templates.ts';
import { api } from '../lib/api.ts';
import { cx, dateTime, timeAgo } from '../lib/format.ts';
import { keys, queryClient, useApp, useCampaigns, usePosts } from '../lib/queries.ts';
import { attempt, toast, useUI } from '../lib/store.ts';
import { STATUS_LABEL } from '../studio/PostCard.tsx';
import { Empty, PageHeader, PageLoader, PlatformBadge, Segmented, Spinner } from '../ui/kit.tsx';
import { Menu } from '../ui/Popover.tsx';
import { CampaignDialog } from './CampaignDialog.tsx';
import { PlanDialog } from './PlanDialog.tsx';

const STATUS_TONE: Record<PostStatus, string> = {
  idea: 'bg-sunken text-ink-2',
  draft: 'bg-warn-soft text-warn',
  scheduled: 'bg-accent-soft text-accent-text',
  published: 'bg-ok-soft text-ok',
};

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  pending: 'Onay bekliyor',
  approved: 'Onaylandı',
  changes: 'Düzeltme istendi',
};

export function StatusChip({ status }: { status: PostStatus }) {
  return <span className={cx('inline-flex h-6 items-center rounded-full px-2.5 text-[0.78rem] font-medium whitespace-nowrap', STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>;
}

export async function createBlankPost(navigate: (path: string) => void, extra: object = {}): Promise<void> {
  const post = await attempt(() => api.post<Post>('/api/posts', { status: 'draft', ...extra }));
  if (post) navigate(`/icerik/${post.id}`);
}

/** Seçili kampanyanın özeti ve tasarım düzeninin durumu. */
function CampaignHeader({ campaign, posts, onClose }: { campaign: Campaign; posts: Post[]; onClose: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState(campaign.title);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const working = useRef(false);
  const failed = useRef(new Set<string>());
  const applied = useRef(0);
  const pending = useUI((state) => {
    const ids = new Set(posts.map((post) => post.id));
    return Object.values(state.jobs).filter((job) => job.postId && ids.has(job.postId) && (job.status === 'queued' || job.status === 'running')).length;
  });

  useEffect(() => setTitle(campaign.title), [campaign.id, campaign.title]);

  const brandOf = (post: Post) => app.entities.find((e) => e.id === post.brandId) ?? null;
  const waiting = posts.filter((post) => needsLayout(post) && !failed.current.has(post.id));

  const run = async (template: string, list: Post[]) => {
    if (working.current || !list.length) return;
    working.current = true;
    setProgress({ done: 0, total: list.length });
    let done = 0;
    for (const post of list) {
      try {
        await applyLayout(post, brandOf(post), template);
        done += 1;
        setProgress({ done, total: list.length });
      } catch (error) {
        failed.current.add(post.id);
        toast(`“${post.title || getPlatform(post.platform).label}” için düzen uygulanamadı: ${error instanceof Error ? error.message : 'bilinmeyen hata'}`, 'error');
      }
    }
    working.current = false;
    setProgress(null);
    applied.current += done;
    await queryClient.invalidateQueries({ queryKey: ['posts'] });
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    // Görseller tek tek geldikçe düzen parça parça uygulanır; haber, hepsi bitince bir kez verilir.
    const ids = new Set(posts.map((post) => post.id));
    const stillGenerating = Object.values(useUI.getState().jobs).some((job) => job.postId && ids.has(job.postId) && (job.status === 'queued' || job.status === 'running'));
    if (applied.current && !stillGenerating) {
      toast(applied.current === 1 ? 'Düzen 1 gönderiye uygulandı.' : `Düzen ${applied.current} gönderiye uygulandı.`, 'ok');
      applied.current = 0;
    }
  };

  // Kampanya bir düzenle kurulduysa, görseli hazır olan gönderilere kendiliğinden uygulanır.
  const waitingKey = waiting.map((post) => post.id).join(',');
  useEffect(() => {
    if (campaign.template && waiting.length) void run(campaign.template, waiting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.template, waitingKey]);

  const rename = async () => {
    const next = title.trim();
    if (!next || next === campaign.title) return setTitle(campaign.title);
    const saved = await attempt(() => api.patch<Campaign>(`/api/campaigns/${campaign.id}`, { title: next }));
    if (saved) void queryClient.invalidateQueries({ queryKey: keys.campaigns });
  };

  const layoutName = TEMPLATES.find((item) => item.id === campaign.template)?.label;

  return (
    <section className="mx-auto mt-5 w-full max-w-[64rem] px-6 max-md:px-4" aria-label="Kampanya">
      <div className="rounded-2xl bg-sunken px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <input
              className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-md bg-transparent px-1.5 text-[1.15rem] font-semibold tracking-[-0.01em] outline-none hover:bg-surface focus:bg-surface"
              aria-label="Kampanya adı"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={rename}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
            <p className="mt-1 line-clamp-2 max-w-[46rem] text-[0.9rem] leading-relaxed text-ink-2">{campaign.brief}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon btn-sm -mt-1 -mr-2" aria-label="Kampanya görünümünü kapat" title="Tüm gönderilere dön" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.84rem] text-ink-2">
          <span>{posts.length} gönderi</span>
          <span>{timeAgo(campaign.createdAt)} hazırlandı</span>
          {layoutName && <span>Düzen: {layoutName}</span>}
          <span className="flex-1" />
          {progress ? (
            <span className="inline-flex items-center gap-2 font-medium text-ink" aria-live="polite">
              <Spinner className="!h-3.5 !w-3.5" /> Düzen uygulanıyor {Math.min(progress.done + 1, progress.total)} / {progress.total}
            </span>
          ) : pending > 0 ? (
            <span className="inline-flex items-center gap-2" aria-live="polite">
              <Spinner className="!h-3.5 !w-3.5" />
              {pending} görsel üretiliyor{campaign.template ? '; hazır olunca düzen uygulanır' : ''}
            </span>
          ) : (
            !campaign.template &&
            waiting.length > 0 && (
              <Menu
                trigger={(props) => (
                  <button type="button" className="btn btn-outline btn-sm" {...props}>
                    <LayoutTemplate /> {waiting.length} görsele düzen uygula
                  </button>
                )}
                items={TEMPLATES.map((template) => ({ label: template.label, onSelect: () => void run(template.id, waiting) }))}
              />
            )
          )}
        </div>
      </div>
    </section>
  );
}

export function PostsPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('kampanya') ?? '';
  const [status, setStatus] = useState<'all' | PostStatus>('all');
  const [brand, setBrand] = useState('');
  const [planning, setPlanning] = useState(false);
  const [packing, setPacking] = useState(false);
  const campaigns = useCampaigns();
  const posts = usePosts({ status: status === 'all' ? undefined : status, brand: brand || undefined, campaign: campaignId || undefined });
  const brands = app.entities.filter((e) => e.type === 'brand');
  const items = posts.data ?? [];
  const campaign = campaigns.data?.find((item) => item.id === campaignId) ?? null;

  const setCampaign = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('kampanya', id);
    else next.delete('kampanya');
    setParams(next, { replace: true });
  };

  const filtered = status !== 'all' || !!brand || !!campaignId;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="İçerik"
        subtitle="Gönderi taslaklarınız: metin, etiketler ve görsel bir arada. Tarih verdikleriniz takvime düşer."
        actions={
          <>
            <button type="button" className="btn btn-outline" onClick={() => setPacking(true)}>
              <Megaphone /> Kampanya paketi
            </button>
            <button type="button" className="btn btn-outline" onClick={() => setPlanning(true)}>
              <Sparkles /> Yapay zekâyla planla
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void createBlankPost(navigate, { brandId: brand || null })}>
              <Plus /> Yeni gönderi
            </button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2.5 pb-3.5">
          <Segmented size="sm" value={status} onChange={setStatus} options={[{ value: 'all', label: 'Tümü' }, ...POST_STATUSES.map((s) => ({ value: s.id, label: s.label }))]} />
          {brands.length > 0 && (
            <select className="input !h-8 !w-auto max-w-52 !text-[0.86rem]" value={brand} onChange={(event) => setBrand(event.target.value)} aria-label="Markaya göre süz">
              <option value="">Tüm markalar</option>
              {brands.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          )}
          {(campaigns.data?.length ?? 0) > 0 && (
            <select className="input !h-8 !w-auto max-w-60 !text-[0.86rem]" value={campaignId} onChange={(event) => setCampaign(event.target.value)} aria-label="Kampanyaya göre süz">
              <option value="">Tüm kampanyalar</option>
              {campaigns.data!.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          )}
        </div>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {campaign && <CampaignHeader key={campaign.id} campaign={campaign} posts={items} onClose={() => setCampaign('')} />}
        {posts.isLoading ? (
          <PageLoader />
        ) : !items.length ? (
          <Empty
            icon={<Newspaper />}
            title={filtered ? 'Bu süzgece uyan gönderi yok' : 'Henüz gönderi yok'}
            body="Tek briften her platforma bir gönderi çıkarın, bir haftalık planı yapay zekâya yazdırın ya da boş bir taslakla başlayın."
            action={
              <>
                <button type="button" className="btn btn-accent" onClick={() => setPacking(true)}>
                  <Megaphone /> Kampanya paketi
                </button>
                <button type="button" className="btn btn-outline" onClick={() => setPlanning(true)}>
                  <Sparkles /> Haftayı planla
                </button>
                <button type="button" className="btn btn-outline" onClick={() => void createBlankPost(navigate)}>
                  <Plus /> Boş taslak
                </button>
              </>
            }
          />
        ) : (
          <ul className="mx-auto w-full max-w-[64rem] px-6 py-3 max-md:px-4">
            {items.map((post) => {
              const brandEntity = post.brandId ? app.entities.find((e) => e.id === post.brandId) : null;
              const slides = post.data.slides?.length ?? 0;
              return (
                <li key={post.id} className="border-b border-line last:border-0">
                  <Link to={`/icerik/${post.id}`} className="-mx-3 flex items-center gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-sunken">
                    {post.assets[0] ? (
                      <img src={post.assets[0].thumbUrl} alt="" loading="lazy" className="h-14 w-14 flex-none rounded-lg bg-sunken object-cover" />
                    ) : (
                      <span className="grid h-14 w-14 flex-none place-items-center rounded-lg border border-dashed border-line-strong text-[0.68rem] text-ink-3">görsel yok</span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <PlatformBadge platform={post.platform} />
                        <span className="truncate text-[0.98rem] font-semibold">{post.title || 'Adsız gönderi'}</span>
                        {slides > 1 && (
                          <span className="inline-flex flex-none items-center gap-1 text-[0.78rem] text-ink-3" title="Kaydırmalı gönderi">
                            <GalleryHorizontalEnd className="h-3.5 w-3.5" /> {slides} kare
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block truncate text-[0.88rem] text-ink-2">{post.caption || 'Metin henüz yazılmadı.'}</span>
                    </span>
                    <span className="flex flex-none flex-col items-end gap-1 max-sm:hidden">
                      <span className="flex items-center gap-2">
                        {post.review && (
                          <span className={cx('text-[0.78rem] font-medium', post.review.status === 'approved' ? 'text-ok' : post.review.status === 'changes' ? 'text-warn' : 'text-ink-3')}>
                            {REVIEW_LABEL[post.review.status]}
                          </span>
                        )}
                        <StatusChip status={post.status} />
                      </span>
                      <span className="note">
                        {post.scheduledAt ? dateTime(post.scheduledAt) : `${timeAgo(post.updatedAt)} düzenlendi`}
                        {brandEntity ? ` · ${brandEntity.name}` : ''}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <PlanDialog open={planning} onClose={() => setPlanning(false)} brandId={brand || undefined} />
      <CampaignDialog open={packing} onClose={() => setPacking(false)} brandId={brand || undefined} />
    </div>
  );
}
