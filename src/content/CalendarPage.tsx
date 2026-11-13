import { ChevronLeft, ChevronRight, Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Post } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { MONTHS_LONG, WEEKDAYS_SHORT, cx, dayKey } from '../lib/format.ts';
import { keys, queryClient, usePosts } from '../lib/queries.ts';
import { attempt } from '../lib/store.ts';
import { PageHeader, PageLoader, PlatformBadge } from '../ui/kit.tsx';
import { PlanDialog } from './PlanDialog.tsx';
import { createBlankPost } from './PostsPage.tsx';

function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  // Hafta pazartesi başlar.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const weeks = Math.ceil((offset + new Date(year, month + 1, 0).getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

function PostChip({ post, onDragStart }: { post: Post; onDragStart: (id: string) => void }) {
  const time = post.scheduledAt ? new Date(post.scheduledAt) : null;
  return (
    <Link
      to={`/icerik/${post.id}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/x-bellek-post', post.id);
        onDragStart(post.id);
      }}
      title={post.title || post.caption}
      className={cx(
        'flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[0.78rem] leading-tight transition-colors',
        post.status === 'published' ? 'border-transparent bg-ok-soft text-ok' : post.status === 'idea' ? 'border-dashed border-line-strong bg-surface text-ink-2' : 'border-line bg-surface text-ink hover:border-line-strong',
      )}
    >
      {post.assets[0] ? (
        <img src={post.assets[0].thumbUrl} alt="" className="h-5 w-5 flex-none rounded-[4px] object-cover" loading="lazy" />
      ) : (
        <PlatformBadge platform={post.platform} className="!h-5 !min-w-5 !rounded-[4px] !text-[0.58rem]" />
      )}
      <span className="min-w-0 flex-1 truncate">{post.title || post.caption || 'Adsız'}</span>
      {time && <span className="meta flex-none !text-[0.66rem] max-xl:hidden">{String(time.getHours()).padStart(2, '0')}:{String(time.getMinutes()).padStart(2, '0')}</span>}
    </Link>
  );
}

export default function CalendarPage() {
  const navigate = useNavigate();
  const today = new Date();
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const posts = usePosts({});
  const all = useMemo(() => posts.data ?? [], [posts.data]);

  const days = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>();
    for (const post of all) {
      if (!post.scheduledAt) continue;
      const key = dayKey(new Date(post.scheduledAt));
      const list = map.get(key) ?? [];
      list.push(post);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
    return map;
  }, [all]);
  const unscheduled = all.filter((p) => !p.scheduledAt && p.status !== 'published');

  const move = (step: number) =>
    setCursor((c) => {
      const date = new Date(c.year, c.month + step, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });

  const drop = async (key: string | null) => {
    const post = all.find((p) => p.id === dragId);
    setDragId(null);
    setOverDay(null);
    if (!post) return;
    let scheduledAt: string | null = null;
    if (key) {
      // Saat korunur; tarihsiz gönderi 10:00'a yerleşir.
      const previous = post.scheduledAt ? new Date(post.scheduledAt) : null;
      const [y, m, d] = key.split('-').map(Number);
      scheduledAt = new Date(y, m - 1, d, previous?.getHours() ?? 10, previous?.getMinutes() ?? 0).toISOString();
      if (previous && dayKey(previous) === key) return;
    } else if (!post.scheduledAt) return;
    // İyimser: gönderi bırakıldığı güne hemen yerleşir.
    queryClient.setQueriesData<Post[]>({ queryKey: ['posts'] }, (list) => list?.map((p) => (p.id === post.id ? { ...p, scheduledAt } : p)));
    const next = await attempt(() => api.patch<Post>(`/api/posts/${post.id}`, { scheduledAt }));
    if (next) queryClient.setQueryData(keys.post(post.id), next);
    void queryClient.invalidateQueries({ queryKey: ['posts'] });
  };

  const todayKey = dayKey(today);
  const monthStart = dayKey(new Date(cursor.year, cursor.month, 1));
  const monthEnd = dayKey(new Date(cursor.year, cursor.month + 1, 0));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Takvim"
        subtitle="Gönderileri sürükleyerek günlere yerleştirin. Bellek yayınlamaz; neyin ne zaman çıkacağını sizin için tutar."
        actions={
          <>
            <button type="button" className="btn btn-outline" onClick={() => setPlanning(true)}>
              <Sparkles /> Yapay zekâyla planla
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void createBlankPost(navigate)}>
              <Plus /> Yeni gönderi
            </button>
          </>
        }
      >
        <div className="flex items-center gap-1.5 pb-3.5">
          <button type="button" className="btn btn-outline btn-icon btn-sm" aria-label="Önceki ay" onClick={() => move(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" className="btn btn-outline btn-icon btn-sm" aria-label="Sonraki ay" onClick={() => move(1)}>
            <ChevronRight />
          </button>
          <h2 className="ml-2 text-[1.05rem] font-semibold">
            {MONTHS_LONG[cursor.month]} {cursor.year}
          </h2>
          {(cursor.year !== today.getFullYear() || cursor.month !== today.getMonth()) && (
            <button type="button" className="btn btn-ghost btn-sm ml-1" onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}>
              Bugün
            </button>
          )}
        </div>
      </PageHeader>

      {posts.isLoading ? (
        <PageLoader />
      ) : (
        <div className="flex min-h-0 flex-1 max-lg:flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
            <div className="grid min-w-[44rem] flex-none grid-cols-7 border-b border-line">
              {WEEKDAYS_SHORT.map((name) => (
                <div key={name} className="px-2.5 py-2 text-[0.78rem] font-medium text-ink-3">{name}</div>
              ))}
            </div>
            <div className="grid min-w-[44rem] flex-1 grid-cols-7" style={{ gridAutoRows: 'minmax(7.2rem, 1fr)' }}>
              {days.map((date) => {
                const key = dayKey(date);
                const inMonth = date.getMonth() === cursor.month;
                const list = byDay.get(key) ?? [];
                return (
                  <div
                    key={key}
                    onDragOver={(event) => {
                      if (!dragId) return;
                      event.preventDefault();
                      setOverDay(key);
                    }}
                    onDragLeave={() => setOverDay((current) => (current === key ? null : current))}
                    onDrop={(event) => {
                      event.preventDefault();
                      void drop(key);
                    }}
                    className={cx(
                      'group/day flex min-w-0 flex-col gap-1 border-r border-b border-line p-1.5 transition-colors',
                      !inMonth && 'bg-sunken/60',
                      overDay === key && 'bg-accent-soft',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={cx(
                          'grid h-6 min-w-6 place-items-center rounded-full px-1 font-mono text-[0.76rem]',
                          key === todayKey ? 'bg-accent font-semibold text-on-accent' : inMonth ? 'text-ink-2' : 'text-ink-3',
                        )}
                      >
                        {date.getDate()}
                      </span>
                      <button
                        type="button"
                        aria-label={`${date.getDate()} ${MONTHS_LONG[date.getMonth()]} için gönderi ekle`}
                        className="grid h-5 w-5 place-items-center rounded text-ink-3 opacity-0 hover:bg-sunken hover:text-ink group-hover/day:opacity-100 focus-visible:opacity-100"
                        onClick={() => void createBlankPost(navigate, { scheduledAt: key })}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {list.slice(0, 4).map((post) => (
                      <PostChip key={post.id} post={post} onDragStart={setDragId} />
                    ))}
                    {list.length > 4 && <span className="px-1 text-[0.72rem] text-ink-3">+{list.length - 4} gönderi daha</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <aside
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              setOverDay('none');
            }}
            onDragLeave={() => setOverDay((current) => (current === 'none' ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              void drop(null);
            }}
            className={cx(
              'flex w-64 flex-none flex-col border-l border-line transition-colors max-lg:max-h-56 max-lg:w-full max-lg:border-t max-lg:border-l-0',
              overDay === 'none' ? 'bg-accent-soft' : 'bg-sunken',
            )}
          >
            <div className="px-4 pt-3.5 pb-2">
              <h3 className="text-[0.9rem] font-semibold">Tarihsiz taslaklar</h3>
              <p className="hint mt-0.5">Bir güne sürükleyerek planlayın.</p>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-4">
              {unscheduled.length ? (
                unscheduled.map((post) => <PostChip key={post.id} post={post} onDragStart={setDragId} />)
              ) : (
                <p className="px-1 text-[0.82rem] text-ink-3">Tarihsiz taslak yok.</p>
              )}
            </div>
          </aside>
        </div>
      )}
      <PlanDialog open={planning} onClose={() => setPlanning(false)} from={monthStart > todayKey ? monthStart : todayKey <= monthEnd ? todayKey : undefined} to={monthStart > todayKey || todayKey <= monthEnd ? monthEnd : undefined} />
    </div>
  );
}
