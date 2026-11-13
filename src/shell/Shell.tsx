import {
  Brain, CalendarDays, Images, LayoutTemplate, Menu as MenuIcon, MoreHorizontal, Moon, Newspaper, Pencil, Pin,
  PinOff, Plus, Search, Settings, ShieldAlert, ShieldCheck, Sparkles, Sun, SunMoon, Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import type { Conversation } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx, timeAgo } from '../lib/format.ts';
import { refreshApp, useApp } from '../lib/queries.ts';
import { attempt, toast, useUI, type Theme } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { IconButton, Logo } from '../ui/kit.tsx';
import { Menu } from '../ui/Popover.tsx';

const NAV = [
  { to: '/', label: 'Stüdyo', icon: Sparkles, match: (path: string) => path === '/' || path.startsWith('/c/') },
  { to: '/hafiza', label: 'Hafıza', icon: Brain },
  { to: '/kutuphane', label: 'Kütüphane', icon: Images },
  { to: '/icerik', label: 'İçerik', icon: Newspaper },
  { to: '/takvim', label: 'Takvim', icon: CalendarDays },
  { to: '/tasarim', label: 'Tasarım', icon: LayoutTemplate },
];

const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = { system: 'Tema: sistem', light: 'Tema: açık', dark: 'Tema: koyu' };

function RenameDialog({ conversation, onClose }: { conversation: Conversation | null; onClose: () => void }) {
  const [title, setTitle] = useState('');
  useEffect(() => setTitle(conversation?.title ?? ''), [conversation]);
  const save = async () => {
    if (!conversation) return;
    await attempt(() => api.patch(`/api/conversations/${conversation.id}`, { title }));
    onClose();
  };
  return (
    <Dialog
      open={!!conversation}
      onClose={onClose}
      size="sm"
      title="Sohbeti yeniden adlandır"
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!title.trim()}>Kaydet</button>
        </>
      }
    >
      <input
        autoFocus
        className="input"
        aria-label="Sohbet adı"
        value={title}
        maxLength={120}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && void save()}
      />
    </Dialog>
  );
}

function ConversationList({ onNavigate }: { onNavigate: () => void }) {
  const app = useApp();
  const navigate = useNavigate();
  const { id: activeId } = useParams();
  const [renaming, setRenaming] = useState<Conversation | null>(null);

  const remove = async (conversation: Conversation) => {
    await attempt(() => api.del(`/api/conversations/${conversation.id}`));
    if (activeId === conversation.id) navigate('/');
    toast('Sohbet çöp kutusuna taşındı.', 'info', {
      label: 'Geri al',
      run: () => void api.post('/api/trash/restore', { kind: 'conversation', id: conversation.id }).then(refreshApp),
    });
    void refreshApp();
  };

  if (!app.conversations.length) {
    return <p className="px-3 py-2 text-[0.84rem] leading-snug text-ink-3">Sohbetleriniz burada birikir; hiçbiri silinmez.</p>;
  }
  return (
    <>
      <ul className="flex flex-col gap-px">
        {app.conversations.slice(0, 60).map((conversation) => (
          <li key={conversation.id} className="group relative">
            <NavLink
              to={`/c/${conversation.id}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'flex h-[2.15rem] items-center gap-2 rounded-lg pr-8 pl-3 text-[0.9rem] transition-colors',
                  isActive ? 'bg-surface font-medium text-ink shadow-card' : 'text-ink-2 hover:bg-surface/70 hover:text-ink',
                )
              }
              title={`${conversation.title || 'Yeni sohbet'} · ${timeAgo(conversation.updatedAt)}`}
            >
              {conversation.pinned && <Pin className="h-3 w-3 flex-none text-accent-text" />}
              <span className="truncate">{conversation.title || conversation.preview || 'Yeni sohbet'}</span>
            </NavLink>
            <Menu
              trigger={(props, open) => (
                <button
                  type="button"
                  {...props}
                  aria-label="Sohbet seçenekleri"
                  className={cx(
                    'absolute top-1/2 right-1 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink',
                    open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                  )}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              )}
              items={[
                { label: 'Yeniden adlandır', icon: <Pencil />, onSelect: () => setRenaming(conversation) },
                {
                  label: conversation.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle',
                  icon: conversation.pinned ? <PinOff /> : <Pin />,
                  onSelect: () => void attempt(() => api.patch(`/api/conversations/${conversation.id}`, { pinned: !conversation.pinned })),
                },
                'divider',
                { label: 'Çöp kutusuna taşı', icon: <Trash2 />, danger: true, onSelect: () => void remove(conversation) },
              ]}
            />
          </li>
        ))}
      </ul>
      <RenameDialog conversation={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}

function SafetyStatus() {
  const app = useApp();
  const broken = app.backup.integrity === 'error';
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 60000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <NavLink
      to="/ayarlar/veri"
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[0.82rem] leading-tight transition-colors hover:bg-surface/70"
    >
      {broken ? <ShieldAlert className="h-[18px] w-[18px] flex-none text-danger" /> : <ShieldCheck className="h-[18px] w-[18px] flex-none text-ok" />}
      <span className="min-w-0">
        <span className={cx('block font-medium', broken ? 'text-danger' : 'text-ink')}>
          {broken ? 'Veritabanı denetimi başarısız' : 'Verileriniz güvende'}
        </span>
        <span className="block truncate text-ink-3">
          {app.backup.lastBackupAt ? `Son yedek ${timeAgo(app.backup.lastBackupAt)}` : 'İlk yedek alınıyor'}
        </span>
      </span>
    </NavLink>
  );
}

export function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const navOpen = useUI((state) => state.navOpen);
  const setNavOpen = useUI((state) => state.setNavOpen);
  const setPaletteOpen = useUI((state) => state.setPaletteOpen);
  const theme = useUI((state) => state.theme);
  const setTheme = useUI((state) => state.setTheme);
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon;

  useEffect(() => setNavOpen(false), [location.pathname, setNavOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  const current = NAV.find((item) => (item.match ? item.match(location.pathname) : location.pathname.startsWith(item.to)));

  return (
    <div className="flex h-full">
      {navOpen && (
        <button
          type="button"
          aria-label="Menüyü kapat"
          className="fixed inset-0 animate-fade bg-black/40 lg:hidden"
          style={{ zIndex: 'var(--z-overlay)' }}
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside
        className={cx(
          'flex w-[264px] flex-none flex-col border-r border-line bg-sunken transition-transform duration-300 ease-out',
          'max-lg:fixed max-lg:inset-y-0 max-lg:left-0',
          navOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
        )}
        style={{ zIndex: 'var(--z-modal)' }}
      >
        <div className="flex h-14 flex-none items-center gap-2.5 pr-2.5 pl-4">
          <Logo />
          <span className="text-[1.08rem] font-semibold tracking-tight">Bellek</span>
          <span className="flex-1" />
          <IconButton label="Ara (⌘K)" size="sm" onClick={() => setPaletteOpen(true)}>
            <Search />
          </IconButton>
        </div>

        <nav className="flex flex-none flex-col gap-px px-2.5" aria-label="Ana menü">
          {NAV.map((item) => {
            const active = item.match ? item.match(location.pathname) : location.pathname.startsWith(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={cx(
                  'flex h-9 items-center gap-2.5 rounded-lg px-3 text-[0.93rem] transition-colors',
                  active ? 'bg-surface font-semibold text-ink shadow-card' : 'text-ink-2 hover:bg-surface/70 hover:text-ink',
                )}
              >
                <item.icon className={cx('h-[17px] w-[17px]', active && 'text-accent-text')} />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <div className="flex flex-none items-center justify-between pr-2.5 pb-1 pl-5.5">
            <span className="text-[0.8rem] font-medium text-ink-3">Sohbetler</span>
            <IconButton label="Yeni sohbet" size="sm" onClick={() => navigate('/')}>
              <Plus />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
            <ConversationList onNavigate={() => setNavOpen(false)} />
          </div>
        </div>

        <div className="flex-none border-t border-line p-2.5">
          <SafetyStatus />
          <div className="mt-0.5 flex items-center gap-1">
            <NavLink
              to="/ayarlar"
              className={({ isActive }) =>
                cx(
                  'flex h-9 flex-1 items-center gap-2.5 rounded-lg px-3 text-[0.93rem] transition-colors',
                  isActive ? 'bg-surface font-semibold shadow-card' : 'text-ink-2 hover:bg-surface/70 hover:text-ink',
                )
              }
            >
              <Settings className="h-[17px] w-[17px]" /> Ayarlar
            </NavLink>
            <IconButton label={THEME_LABEL[theme]} size="sm" onClick={() => setTheme(THEME_NEXT[theme])}>
              <ThemeIcon />
            </IconButton>
          </div>
        </div>
      </aside>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex h-12 flex-none items-center gap-2 border-b border-line px-2.5 lg:hidden">
          <IconButton label="Menü" onClick={() => setNavOpen(true)}>
            <MenuIcon />
          </IconButton>
          <span className="text-[0.95rem] font-semibold">{current?.label ?? 'Bellek'}</span>
          <span className="flex-1" />
          <IconButton label="Ara" onClick={() => setPaletteOpen(true)}>
            <Search />
          </IconButton>
        </div>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
