import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { AuthState, InviteInfo, Me } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { adoptSession, setMe, signOut } from '../lib/auth.ts';
import { Field, Logo, Notice, Spinner } from '../ui/kit.tsx';
import { AvatarPicker } from './AvatarPicker.tsx';

export function Splash({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="grid min-h-full place-items-center px-6 py-10">
        <div className={`flex w-full flex-col items-center text-center ${wide ? 'max-w-[26rem]' : 'max-w-sm'}`}>
          <Logo size={44} />
          {children}
        </div>
      </div>
    </div>
  );
}

/** Göster/gizle düğmeli şifre alanı. */
export function PasswordInput({ value, onChange, placeholder, autoComplete, label, autoFocus, invalid }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete: 'current-password' | 'new-password' | 'off';
  label: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative block">
      <input
        type={visible ? 'text' : 'password'}
        className="input !pr-10"
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="absolute top-1/2 right-1.5 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-ink-3 hover:text-ink"
        aria-label={visible ? 'Şifreyi gizle' : 'Şifreyi göster'}
        title={visible ? 'Şifreyi gizle' : 'Şifreyi göster'}
        onClick={() => setVisible(!visible)}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </span>
  );
}

function useSubmit<T>(run: () => Promise<T>, done: (result: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      done(await run());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Bir şeyler ters gitti.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

/** İlk açılış: henüz hiç hesap yok. Bu formu dolduran takımın sahibi olur. */
export function SetupScreen({ state }: { state: AuthState }) {
  const [teamName, setTeamName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const { busy, error, submit } = useSubmit(
    () => api.post<AuthState>('/api/auth/setup', { teamName, name, email, password, code }),
    adoptSession,
  );

  if (state.setupMode === 'local-only') {
    return (
      <Splash wide>
        <h1 className="mt-5 text-xl font-semibold">Önce takım sahibi hesabı açılmalı</h1>
        <p className="mt-2 text-[0.93rem] leading-relaxed text-ink-2">
          Güvenlik için ilk hesap yalnızca Bellek'in çalıştığı bilgisayardan oluşturulur. O bilgisayarda tarayıcıyı açıp{' '}
          <code className="meta">localhost</code> adresinden kurulumu tamamlayın; sonra buradan giriş yapabilirsiniz.
        </p>
      </Splash>
    );
  }

  const ready = name.trim() && email.trim() && password.length >= 8 && (state.setupMode !== 'code' || code);
  return (
    <Splash wide>
      <h1 className="mt-5 text-xl font-semibold">Hesabınızı oluşturun</h1>
      <p className="mt-1.5 text-[0.93rem] leading-relaxed text-ink-2">
        Bu hesap takımın sahibi olur. Arkadaşlarınızı sonra Ayarlar → Takım bölümünden kendiniz eklersiniz.
      </p>
      <form onSubmit={submit} className="mt-6 flex w-full flex-col gap-3.5 text-left">
        <Field label="Adınız">
          <input className="input" autoFocus autoComplete="name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Takım adı" hint="Boş bırakırsanız adınızla kurulur; sonra değiştirebilirsiniz.">
          <input className="input" placeholder="Örn. Ajans Ekibi" value={teamName} maxLength={60} onChange={(event) => setTeamName(event.target.value)} />
        </Field>
        <Field label="E-posta">
          <input className="input" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Şifre" hint="En az 8 karakter.">
          <PasswordInput label="Şifre" autoComplete="new-password" value={password} onChange={setPassword} />
        </Field>
        {state.setupMode === 'code' && (
          <Field label="Kurulum kodu" hint="Sunucuyu başlatırken BELLEK_PASSWORD olarak verdiğiniz değer.">
            <PasswordInput label="Kurulum kodu" autoComplete="off" value={code} onChange={setCode} />
          </Field>
        )}
        {error && <Notice level="error">{error}</Notice>}
        <button type="submit" className="btn btn-primary mt-1" disabled={busy || !ready}>
          {busy && <Spinner />} Takımı kur
        </button>
        <p className="hint text-center">Var olan hafızanız, kütüphaneniz ve sohbetleriniz olduğu gibi kalır.</p>
      </form>
    </Splash>
  );
}

export function LoginScreen({ state }: { state: AuthState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(() => api.post<AuthState>('/api/auth/login', { email, password }), adoptSession);
  return (
    <Splash>
      <h1 className="mt-5 text-xl font-semibold">{state.teamName || 'Bellek'}</h1>
      <p className="mt-1 text-[0.93rem] text-ink-2">Hesabınızla giriş yapın.</p>
      <form onSubmit={submit} className="mt-6 flex w-full flex-col gap-3 text-left">
        <input
          type="email"
          autoFocus
          className="input"
          placeholder="E-posta"
          aria-label="E-posta"
          autoComplete="username"
          aria-invalid={!!error || undefined}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <PasswordInput label="Şifre" placeholder="Şifre" autoComplete="current-password" invalid={!!error} value={password} onChange={setPassword} />
        {error && <p className="text-[0.85rem] text-danger" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>
          {busy && <Spinner />} Giriş yap
        </button>
      </form>
      <p className="hint mt-5">Hesabınız yoksa ya da şifrenizi unuttuysanız takım yöneticinize yazın.</p>
    </Splash>
  );
}

/**
 * İlk giriş: üye adını yazar, isterse profil resmi ekler ve yöneticinin verdiği şifre yerine
 * kendi şifresini belirler. Şifresi sonradan sıfırlanan üyeden yalnızca yeni şifre istenir.
 */
export function WelcomeScreen({ state }: { state: AuthState }) {
  const user = state.user!;
  const firstTime = !user.onboarded;
  const needsPassword = user.mustChangePassword;
  const [me, setLocalMe] = useState<Me>(user);
  const [name, setName] = useState(user.name);
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(() => api.post<Me>('/api/auth/me/complete', { name, password }), setMe);
  const ready = (!firstTime || name.trim()) && (!needsPassword || password.length >= 8);

  return (
    <Splash wide>
      <h1 className="mt-5 text-xl font-semibold">
        {firstTime ? (state.teamName ? `${state.teamName} takımına hoş geldiniz` : 'Hoş geldiniz') : 'Yeni şifrenizi belirleyin'}
      </h1>
      <p className="mt-1.5 text-[0.93rem] leading-relaxed text-ink-2">
        {firstTime
          ? 'Takım arkadaşlarınız sizi bu adla görecek. İsterseniz bir profil resmi de ekleyin.'
          : 'Şifreniz takım yöneticisi tarafından sıfırlandı. Devam etmek için yalnızca sizin bildiğiniz bir şifre belirleyin.'}
      </p>
      <form onSubmit={submit} className="mt-6 flex w-full flex-col gap-5 text-left">
        {firstTime && (
          <>
            <AvatarPicker me={me} name={name || me.email} onChange={setLocalMe} />
            <Field label="Adınız">
              <input className="input" autoFocus autoComplete="name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </Field>
          </>
        )}
        {needsPassword && (
          <Field
            label="Yeni şifreniz"
            hint={firstTime ? 'Size verilen şifre yalnızca ilk giriş içindi. En az 8 karakterlik, kendinize ait bir şifre belirleyin.' : 'En az 8 karakter; size verilen şifreden farklı olmalı.'}
          >
            <PasswordInput label="Yeni şifreniz" autoComplete="new-password" autoFocus={!firstTime} value={password} onChange={setPassword} />
          </Field>
        )}
        {error && <Notice level="error">{error}</Notice>}
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy && <Spinner />} {firstTime ? 'Stüdyoya gir' : 'Şifreyi kaydet'}
        </button>
      </form>
      <button type="button" className="hint mt-5 underline underline-offset-2 hover:text-ink" onClick={() => void signOut()}>
        {me.email} değil misiniz? Çıkış yapın
      </button>
    </Splash>
  );
}

/** Davet bağlantısının açtığı ekran: e-posta bellidir, üye kendisine iletilen şifreyle girer. */
export function InviteScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InviteInfo>(`/api/auth/invite/${encodeURIComponent(token)}`),
    retry: false,
    staleTime: Infinity,
  });
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(
    () => api.post<AuthState>('/api/auth/login', { email: invite.data?.email ?? '', password }),
    (state) => {
      adoptSession(state);
      onDone();
    },
  );

  if (invite.isLoading) {
    return (
      <Splash>
        <Spinner className="mt-6 text-ink-3" />
      </Splash>
    );
  }
  if (!invite.data) {
    return (
      <Splash wide>
        <h1 className="mt-5 text-xl font-semibold">Bu davet artık geçerli değil</h1>
        <p className="mt-2 text-[0.93rem] leading-relaxed text-ink-2">
          Bağlantı daha önce kullanılmış ya da hesap kapatılmış olabilir. Hesabınız varsa e-posta ve şifrenizle giriş yapabilirsiniz.
        </p>
        <button type="button" className="btn btn-primary mt-5" onClick={onDone}>
          Giriş ekranına git
        </button>
      </Splash>
    );
  }
  return (
    <Splash wide>
      <h1 className="mt-5 text-xl font-semibold">{invite.data.teamName ? `${invite.data.teamName} takımına davet edildiniz` : 'Davet edildiniz'}</h1>
      <p className="mt-1.5 text-[0.93rem] leading-relaxed text-ink-2">
        Size iletilen şifreyle giriş yapın. Ardından adınızı yazıp kendi şifrenizi belirleyeceksiniz.
      </p>
      <form onSubmit={submit} className="mt-6 flex w-full flex-col gap-3.5 text-left">
        <Field label="E-posta">
          <input className="input" type="email" value={invite.data.email} readOnly autoComplete="username" />
        </Field>
        <Field label="Size verilen şifre">
          <PasswordInput label="Size verilen şifre" autoComplete="current-password" autoFocus invalid={!!error} value={password} onChange={setPassword} />
        </Field>
        {error && <p className="text-[0.85rem] text-danger" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary mt-1" disabled={busy || !password}>
          {busy && <Spinner />} Giriş yap
        </button>
      </form>
    </Splash>
  );
}
