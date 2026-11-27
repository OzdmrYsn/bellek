import { useQuery } from '@tanstack/react-query';
import { LogOut, MonitorSmartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PRESETS, presetOf } from '../../shared/permissions.ts';
import type { Me, SessionInfo } from '../../shared/types.ts';
import { AvatarPicker } from '../auth/AvatarPicker.tsx';
import { PasswordInput } from '../auth/AuthScreens.tsx';
import { api } from '../lib/api.ts';
import { setMe, signOut, useMe } from '../lib/auth.ts';
import { timeAgo, usd } from '../lib/format.ts';
import { queryClient, useApp } from '../lib/queries.ts';
import { attempt, toast } from '../lib/store.ts';
import { Field, SettingRow, Spinner } from '../ui/kit.tsx';

const sessionsKey = ['sessions'] as const;

export function roleName(member: { role: string; permissions?: readonly string[] }): string {
  if (member.role === 'owner') return 'Takım sahibi';
  const preset = presetOf(member.permissions ?? []);
  return preset === 'custom' ? 'Özel yetkiler' : PRESETS.find((item) => item.id === preset)!.label;
}

function Profile() {
  const me = useMe();
  const app = useApp();
  const team = app.team;
  const spend = app.spend;
  const [name, setName] = useState(me.name);
  useEffect(() => setName(me.name), [me.name]);

  const save = async () => {
    const clean = name.trim();
    if (!clean) return setName(me.name);
    if (clean === me.name) return;
    const next = await attempt(() => api.patch<Me>('/api/auth/me', { name: clean }), 'Adınız güncellendi.');
    if (next) setMe(next);
  };

  return (
    <section className="mb-9">
      <h2 className="text-[1.08rem] font-semibold">Profil</h2>
      <p className="hint mt-0.5">
        {team.name ? `${team.name} · ` : ''}
        {roleName(me)}
        {(spend.month > 0 || spend.limit !== null) && (
          <>
            {' · '}bu ay {usd(spend.month)}
            {spend.limit !== null ? ` / ${usd(spend.limit)} sınır` : ' harcama'}
          </>
        )}
      </p>
      <div className="mt-4 flex flex-col gap-5">
        <AvatarPicker me={me} onChange={setMe} />
        <div className="grid max-w-[34rem] gap-4 sm:grid-cols-2">
          <Field label="Ad">
            <input
              className="input"
              value={name}
              maxLength={80}
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void save()}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
          </Field>
          <Field label="E-posta" hint={me.role === 'owner' ? undefined : 'Değiştirmek için takım yöneticinize yazın.'}>
            <input className="input" value={me.email} readOnly disabled />
          </Field>
        </div>
      </div>
    </section>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const ok = await attempt(() => api.post('/api/auth/me/password', { current, next }), 'Şifreniz değişti. Diğer cihazlardaki oturumlar kapatıldı.');
    setBusy(false);
    if (ok) {
      setCurrent('');
      setNext('');
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    }
  };

  return (
    <section className="mb-9">
      <h2 className="text-[1.08rem] font-semibold">Şifre</h2>
      <p className="hint mt-0.5 max-w-[40rem]">Hesabınızı takım yöneticisi açtıysa ilk şifreyi o belirlemiştir; yalnızca sizin bildiğiniz bir şifreyle değiştirmeniz iyi olur.</p>
      <form
        className="mt-4 grid max-w-[34rem] items-end gap-4 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Şimdiki şifre">
          <PasswordInput label="Şimdiki şifre" autoComplete="current-password" value={current} onChange={setCurrent} />
        </Field>
        <Field label="Yeni şifre">
          <PasswordInput label="Yeni şifre" autoComplete="new-password" placeholder="En az 8 karakter" value={next} onChange={setNext} />
        </Field>
        <button type="submit" className="btn btn-outline" disabled={busy || !current || next.length < 8}>
          {busy && <Spinner />} Değiştir
        </button>
      </form>
    </section>
  );
}

function Sessions() {
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: () => api.get<SessionInfo[]>('/api/auth/sessions') });
  const list = sessions.data ?? [];
  const apply = (next: SessionInfo[] | undefined) => next && queryClient.setQueryData(sessionsKey, next);
  const others = list.filter((item) => !item.current).length;

  return (
    <section className="mb-9">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[1.08rem] font-semibold">Açık oturumlar</h2>
          <p className="hint mt-0.5">Hesabınıza giriş yapılmış cihazlar. Tanımadığınız bir cihaz varsa oturumunu kapatıp şifrenizi değiştirin.</p>
        </div>
        {others > 0 && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={async () => apply(await attempt(() => api.post<SessionInfo[]>('/api/auth/sessions/revoke-others'), 'Diğer oturumlar kapatıldı.'))}
          >
            Diğerlerini kapat
          </button>
        )}
      </div>
      {sessions.isLoading ? (
        <div className="grid h-20 place-items-center text-ink-3"><Spinner /></div>
      ) : (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {list.map((item) => (
            <li key={item.id} className="flex items-center gap-3.5 py-2.5">
              <MonitorSmartphone className="h-[18px] w-[18px] flex-none text-ink-3" />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.93rem]">
                  {item.device}
                  {item.current && <span className="badge ml-2">Bu cihaz</span>}
                </span>
                <span className="note">
                  {item.ip ? `${item.ip} · ` : ''}son etkinlik {timeAgo(item.lastSeenAt)}
                </span>
              </span>
              {!item.current && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => apply(await attempt(() => api.del<SessionInfo[]>(`/api/auth/sessions/${item.id}`)))}
                >
                  Kapat
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AccountSection() {
  return (
    <>
      <Profile />
      <Password />
      <Sessions />
      <section>
        <div className="divide-y divide-line border-y border-line">
          <SettingRow title="Çıkış yap" description="Bu cihazdaki oturumunuz kapanır. Yeniden girmek için e-posta ve şifreniz gerekir.">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                toast('Çıkış yapılıyor…');
                void signOut();
              }}
            >
              <LogOut /> Çıkış yap
            </button>
          </SettingRow>
        </div>
      </section>
    </>
  );
}
