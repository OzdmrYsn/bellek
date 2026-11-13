import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useState, type FormEvent } from 'react';
import { Navigate, Route, Routes, matchPath, useLocation } from 'react-router';
import { PostEditorPage } from './content/PostEditor.tsx';
import { PostsPage } from './content/PostsPage.tsx';
import { ReviewPage } from './content/ReviewPage.tsx';
import { api } from './lib/api.ts';
import { useLive } from './lib/live.ts';
import { useBootstrap } from './lib/queries.ts';
import { applyTheme, useUI } from './lib/store.ts';
import { AssetPickerHost } from './library/AssetPicker.tsx';
import { LibraryPage } from './library/LibraryPage.tsx';
import { Lightbox } from './library/Lightbox.tsx';
import { PeopleDialogHost } from './library/PeopleDialog.tsx';
import { EntityPage } from './memory/EntityPage.tsx';
import { MemoryPage } from './memory/MemoryPage.tsx';
import { CommandPalette } from './shell/CommandPalette.tsx';
import { Shell } from './shell/Shell.tsx';
import { StudioPage } from './studio/StudioPage.tsx';
import { ConfirmHost } from './ui/Dialog.tsx';
import { Logo, PageLoader, Spinner, Toasts } from './ui/kit.tsx';

const CalendarPage = lazy(() => import('./content/CalendarPage.tsx'));
const DesignsPage = lazy(() => import('./design/DesignsPage.tsx'));
const DesignEditorPage = lazy(() => import('./design/DesignEditor.tsx'));
const SettingsPage = lazy(() => import('./settings/SettingsPage.tsx'));

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <Logo size={44} />
        {children}
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth', { password });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Giriş yapılamadı.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Splash>
      <h1 className="mt-5 text-xl font-semibold">Bellek</h1>
      <p className="mt-1 text-[0.93rem] text-ink-2">Bu stüdyo parolayla korunuyor.</p>
      <form onSubmit={submit} className="mt-6 flex w-full flex-col gap-3 text-left">
        <input
          type="password"
          autoFocus
          className="input"
          placeholder="Parola"
          aria-label="Parola"
          aria-invalid={!!error}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <p className="text-[0.85rem] text-danger">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || !password}>
          {busy && <Spinner />} Giriş yap
        </button>
      </form>
    </Splash>
  );
}

/** Onay bağlantıları oturum ve uygulama verisi gerektirmez; kabuğun dışında açılır. */
export function App() {
  const location = useLocation();
  const token = matchPath('/onay/:token', location.pathname)?.params.token;
  if (token) return <ReviewPage token={token} />;
  return <Studio />;
}

function Studio() {
  const client = useQueryClient();
  const theme = useUI((state) => state.theme);
  const auth = useQuery({
    queryKey: ['auth'],
    queryFn: () => api.get<{ required: boolean; ok: boolean }>('/api/auth'),
    retry: 2,
    staleTime: Infinity,
  });
  const allowed = !!auth.data && (!auth.data.required || auth.data.ok);
  const boot = useBootstrap();
  useLive(allowed && !!boot.data);

  useEffect(() => applyTheme(theme), [theme]);

  // Oturum sonradan düşerse giriş ekranına dön.
  useEffect(() => {
    const onExpired = () => void client.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener('bellek:oturum', onExpired);
    return () => window.removeEventListener('bellek:oturum', onExpired);
  }, [client]);

  if (auth.data?.required && !auth.data.ok) {
    return (
      <Login
        onDone={() => {
          void client.invalidateQueries({ queryKey: ['auth'] });
          void client.invalidateQueries({ queryKey: ['bootstrap'] });
        }}
      />
    );
  }

  if (!boot.data) {
    if (auth.isError || boot.isError) {
      return (
        <Splash>
          <h1 className="mt-5 text-lg font-semibold">Sunucuya ulaşılamıyor</h1>
          <p className="mt-1.5 text-[0.93rem] leading-relaxed text-ink-2">
            Bellek sunucusu çalışmıyor olabilir. Terminalde <code className="meta">npm run dev</code> komutunun açık olduğundan emin olun.
          </p>
          <button
            type="button"
            className="btn btn-primary mt-5"
            onClick={() => {
              void auth.refetch();
              void boot.refetch();
            }}
          >
            Yeniden dene
          </button>
        </Splash>
      );
    }
    return (
      <Splash>
        <Spinner className="mt-6 text-ink-3" />
      </Splash>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<StudioPage />} />
          <Route path="c/:id" element={<StudioPage />} />
          <Route path="hafiza" element={<MemoryPage />} />
          <Route path="hafiza/:id" element={<EntityPage />} />
          <Route path="kutuphane" element={<LibraryPage />} />
          <Route path="icerik" element={<PostsPage />} />
          <Route path="icerik/:id" element={<PostEditorPage />} />
          <Route path="takvim" element={<Suspense fallback={<PageLoader />}><CalendarPage /></Suspense>} />
          <Route path="tasarim" element={<Suspense fallback={<PageLoader />}><DesignsPage /></Suspense>} />
          <Route path="tasarim/:id" element={<Suspense fallback={<PageLoader />}><DesignEditorPage /></Suspense>} />
          <Route path="ayarlar/:section?" element={<Suspense fallback={<PageLoader />}><SettingsPage /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Lightbox />
      <AssetPickerHost />
      <PeopleDialogHost />
      <CommandPalette />
      <ConfirmHost />
      <Toasts />
    </>
  );
}
