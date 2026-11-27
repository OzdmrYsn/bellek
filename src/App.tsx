import { useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, matchPath, useLocation, useNavigate } from 'react-router';
import { InviteScreen, LoginScreen, SetupScreen, Splash, WelcomeScreen } from './auth/AuthScreens.tsx';
import { PostEditorPage } from './content/PostEditor.tsx';
import { PostsPage } from './content/PostsPage.tsx';
import { ReviewPage } from './content/ReviewPage.tsx';
import { authKey, useAuth } from './lib/auth.ts';
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
import { PageLoader, Spinner, Toasts } from './ui/kit.tsx';

const CalendarPage = lazy(() => import('./content/CalendarPage.tsx'));
const DesignsPage = lazy(() => import('./design/DesignsPage.tsx'));
const DesignEditorPage = lazy(() => import('./design/DesignEditor.tsx'));
const SettingsPage = lazy(() => import('./settings/SettingsPage.tsx'));

/** Onay bağlantıları oturum ve uygulama verisi gerektirmez; kabuğun dışında açılır. */
export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = matchPath('/onay/:token', location.pathname)?.params.token;
  if (token) return <ReviewPage token={token} />;
  // Davet bağlantısı: giriş yapılınca ana sayfaya dönülür, ilk giriş adımı oradan sürer.
  const invite = matchPath('/davet/:token', location.pathname)?.params.token;
  if (invite) return <InviteScreen token={invite} onDone={() => navigate('/', { replace: true })} />;
  return <Studio />;
}

function Studio() {
  const client = useQueryClient();
  const theme = useUI((state) => state.theme);
  const auth = useAuth();
  const user = auth.data?.user ?? null;
  // Açılış verisi yalnızca oturum açık, ilk giriş adımı tamam ve şifre üyenin kendi şifresiyse istenir.
  const pending = !!user && (!user.onboarded || user.mustChangePassword);
  const allowed = !!user && !pending;
  const boot = useBootstrap(allowed);
  useLive(allowed && !!boot.data);

  useEffect(() => applyTheme(theme), [theme]);

  // Oturum sonradan düşerse (süresi doldu, hesap kapatıldı) giriş ekranına dön.
  useEffect(() => {
    const onExpired = () => void client.invalidateQueries({ queryKey: authKey });
    window.addEventListener('bellek:oturum', onExpired);
    return () => window.removeEventListener('bellek:oturum', onExpired);
  }, [client]);

  if (auth.data && !user) {
    return (
      <>
        {auth.data.setup ? <SetupScreen state={auth.data} /> : <LoginScreen state={auth.data} />}
        <Toasts />
      </>
    );
  }
  if (auth.data && user && pending) {
    return (
      <>
        <WelcomeScreen state={auth.data} />
        <Toasts />
      </>
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
