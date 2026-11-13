import { useQuery } from '@tanstack/react-query';
import {
  Brain, CalendarDays, CornerDownLeft, Image as ImageIcon, Images, LayoutTemplate, MessageSquare, Newspaper, Plus,
  Search, Settings, StickyNote, UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { foldText } from '../../shared/handles.ts';
import type { SearchResult } from '../../shared/types.ts';
import { api, qs } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { useApp } from '../lib/queries.ts';
import { useUI } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Avatar } from '../ui/kit.tsx';

interface Row {
  key: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  run: () => void;
}

const KIND_ICON: Record<SearchResult['kind'], ReactNode> = {
  conversation: <MessageSquare />,
  entity: <UserRound />,
  asset: <ImageIcon />,
  post: <Newspaper />,
  memory: <StickyNote />,
};

export function CommandPalette() {
  const open = useUI((state) => state.paletteOpen);
  const setOpen = useUI((state) => state.setPaletteOpen);
  const openLightbox = useUI((state) => state.openLightbox);
  const app = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 160);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useQuery({
    queryKey: ['search', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: () => api.get<SearchResult[]>(`/api/search${qs({ q: debounced })}`),
    staleTime: 5000,
  });

  const rows = useMemo<Row[]>(() => {
    const go = (path: string) => () => navigate(path);
    const actions: Row[] = [
      { key: 'new', group: 'Eylemler', title: 'Yeni sohbet', icon: <Plus />, run: go('/') },
      { key: 'person', group: 'Eylemler', title: 'Kişi ekle', icon: <UserRound />, run: go('/hafiza?yeni=person') },
      { key: 'brand', group: 'Eylemler', title: 'Marka ekle', icon: <Brain />, run: go('/hafiza?yeni=brand') },
      { key: 'library', group: 'Git', title: 'Kütüphane', icon: <Images />, run: go('/kutuphane') },
      { key: 'memory', group: 'Git', title: 'Hafıza', icon: <Brain />, run: go('/hafiza') },
      { key: 'posts', group: 'Git', title: 'İçerik', icon: <Newspaper />, run: go('/icerik') },
      { key: 'calendar', group: 'Git', title: 'Takvim', icon: <CalendarDays />, run: go('/takvim') },
      { key: 'design', group: 'Git', title: 'Tasarım', icon: <LayoutTemplate />, run: go('/tasarim') },
      { key: 'settings', group: 'Git', title: 'Ayarlar', icon: <Settings />, run: go('/ayarlar') },
    ];
    const needle = foldText(query.trim());
    if (!needle) {
      const recent: Row[] = app.conversations.slice(0, 5).map((c) => ({
        key: `c${c.id}`, group: 'Son sohbetler', title: c.title || c.preview || 'Yeni sohbet', icon: <MessageSquare />, run: go(`/c/${c.id}`),
      }));
      return [...actions.slice(0, 3), ...recent, ...actions.slice(3)];
    }
    const matched = actions.filter((a) => foldText(a.title).includes(needle));
    const entities: Row[] = app.entities
      .filter((e) => foldText(e.name).includes(needle) || e.handle.includes(needle.replace(/^@/, '')))
      .slice(0, 6)
      .map((e) => ({
        key: `e${e.id}`, group: 'Hafıza', title: e.name, subtitle: `@${e.handle}`, icon: <Avatar entity={e} size={22} />, run: go(`/hafiza/${e.id}`),
      }));
    const seen = new Set(entities.map((e) => e.key));
    const found: Row[] = (results.data ?? [])
      .filter((r) => !(r.kind === 'entity' && seen.has(`e${r.id}`)))
      .map((r) => ({
        key: `${r.kind}${r.id}`,
        group: r.kind === 'conversation' ? 'Sohbetler' : r.kind === 'asset' ? 'Kütüphane' : r.kind === 'post' ? 'İçerik' : 'Hafıza',
        title: r.title,
        subtitle: r.subtitle,
        icon: r.thumbUrl ? <img src={r.thumbUrl} alt="" className="h-[22px] w-[22px] rounded object-cover" /> : KIND_ICON[r.kind],
        run:
          r.kind === 'conversation' ? go(`/c/${r.id}`)
          : r.kind === 'entity' ? go(`/hafiza/${r.id}`)
          : r.kind === 'post' ? go(`/icerik/${r.id}`)
          : r.kind === 'asset' ? () => openLightbox([r.id], 0)
          : go('/hafiza?sekme=notes'),
      }));
    return [...entities, ...matched, ...found];
  }, [query, app.conversations, app.entities, results.data, navigate, openLightbox]);

  useEffect(() => setIndex(0), [rows.length, query]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    setOpen(false);
    row.run();
  };

  let lastGroup = '';
  return (
    <Dialog open={open} onClose={() => setOpen(false)} bare className="mt-[12dvh] w-[min(36rem,calc(100vw-2rem))]">
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search className="h-[18px] w-[18px] flex-none text-ink-3" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((i) => Math.min(rows.length - 1, i + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(rows[index]);
            }
          }}
          placeholder="Sohbet, kişi, marka, görsel ara ya da bir eylem yaz"
          aria-label="Ara"
          className="h-13 min-w-0 flex-1 bg-transparent text-[1rem] outline-none"
        />
        <span className="kbd">esc</span>
      </div>
      <div ref={list} className="max-h-[min(52dvh,26rem)] overflow-y-auto p-1.5">
        {rows.length === 0 && (
          <p className="px-3 py-8 text-center text-[0.9rem] text-ink-3">
            {results.isFetching ? 'Aranıyor…' : `“${query.trim()}” için bir şey bulunamadı.`}
          </p>
        )}
        {rows.map((row, i) => {
          const header = row.group !== lastGroup ? row.group : null;
          lastGroup = row.group;
          return (
            <div key={row.key}>
              {header && <div className="px-2.5 pt-2.5 pb-1 text-[0.76rem] font-medium text-ink-3">{header}</div>}
              <button
                type="button"
                data-active={i === index}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(row)}
                className={cx('menu-item', '!py-2')}
              >
                <span className="grid h-[22px] w-[22px] flex-none place-items-center [&>svg]:h-[17px] [&>svg]:w-[17px]">{row.icon}</span>
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
                {row.subtitle && <span className="meta flex-none">{row.subtitle}</span>}
                {i === index && <CornerDownLeft className="!h-3.5 !w-3.5" />}
              </button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
