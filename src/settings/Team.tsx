import { useQuery } from '@tanstack/react-query';
import {
  Check, Copy, History, KeyRound, Link2, MoreHorizontal, RefreshCw, ShieldCheck, SlidersHorizontal, UserMinus, UserPlus, UserRoundCheck,
  UserRoundX, Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  ALL_PERMISSIONS, PERMISSIONS, PERMISSION_GROUPS, PRESETS, normalizePermissions, presetOf, type Permission, type PresetId,
} from '../../shared/permissions.ts';
import type { ActivityEntry, Team, TeamMember } from '../../shared/types.ts';
import { PasswordInput } from '../auth/AuthScreens.tsx';
import { api } from '../lib/api.ts';
import { generatePassword, teamKey, useCan, useMe, useTeam } from '../lib/auth.ts';
import { copyText, cx, dateTime, timeAgo } from '../lib/format.ts';
import { queryClient, refreshApp } from '../lib/queries.ts';
import { attempt, confirmDialog, toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Empty, Field, IconButton, Notice, Segmented, Spinner, Switch, UserAvatar } from '../ui/kit.tsx';
import { Menu } from '../ui/Popover.tsx';
import { roleName } from './Account.tsx';

function refreshTeam(): void {
  void queryClient.invalidateQueries({ queryKey: teamKey });
  void queryClient.invalidateQueries({ queryKey: ['activity'] });
  void refreshApp();
}

// ───────────────────────── Yetki düzenleyici ─────────────────────────

/**
 * Önce hazır bir rol seçilir, sonra istenirse tek tek ince ayar yapılır. `grantable`
 * dışındaki anahtarlar kilitlidir: kimse kendinde olmayan bir yetkiyi veremez.
 */
function PermissionEditor({ value, onChange, grantable }: { value: Permission[]; onChange: (next: Permission[]) => void; grantable: Permission[] }) {
  const preset = presetOf(value);
  const presets = PRESETS.filter((item) => item.permissions.every((permission) => grantable.includes(permission)));
  const toggle = (id: Permission, on: boolean) => {
    const next = on ? [...value, id] : value.filter((item) => item !== id);
    // "Anahtarları yönetebilir" kapanmadan "görebilir" kapatılamaz; ikisi birlikte düşer.
    onChange(normalizePermissions(!on && id === 'providers.view' ? next.filter((item) => item !== 'providers.manage') : next));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="label !mb-0">Yetkiler</span>
        <Segmented<PresetId | 'custom'>
          size="sm"
          value={preset}
          onChange={(id) => {
            const picked = PRESETS.find((item) => item.id === id);
            if (picked) onChange(normalizePermissions(picked.permissions));
          }}
          options={[
            ...presets.map((item) => ({ value: item.id, label: item.label, title: item.description })),
            ...(preset === 'custom' ? [{ value: 'custom' as const, label: 'Özel' }] : []),
          ]}
        />
      </div>
      <p className="hint mt-1.5">
        {preset === 'custom' ? 'Hazır rollerden farklı, elle seçilmiş yetkiler.' : PRESETS.find((item) => item.id === preset)!.description}
      </p>
      <div className="mt-3 overflow-hidden rounded-[12px] border border-line">
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.id} className="border-b border-line last:border-0">
            <div className="bg-sunken px-3.5 py-1.5 text-[0.78rem] font-semibold tracking-wide text-ink-3 uppercase">{group.label}</div>
            <ul className="divide-y divide-line">
              {PERMISSIONS.filter((item) => item.group === group.id).map((item) => {
                const locked = !grantable.includes(item.id);
                return (
                  <li key={item.id} className={cx('flex items-center gap-4 px-3.5 py-2.5', locked && 'opacity-55')}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.92rem] font-medium">{item.label}</span>
                      <span className="block text-[0.82rem] leading-snug text-ink-3">{item.description}</span>
                    </span>
                    <Switch
                      checked={value.includes(item.id)}
                      disabled={locked}
                      label={item.label}
                      onChange={(on) => toggle(item.id, on)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function PasswordField({ value, onChange, hint }: { value: string; onChange: (value: string) => void; hint: string }) {
  return (
    <Field label="Şifre" hint={hint}>
      <span className="flex gap-2">
        <span className="min-w-0 flex-1">
          <PasswordInput label="Şifre" autoComplete="new-password" placeholder="En az 8 karakter" value={value} onChange={onChange} />
        </span>
        <button type="button" className="btn btn-outline" title="Rastgele güçlü bir şifre üret" onClick={() => onChange(generatePassword())}>
          <RefreshCw /> Üret
        </button>
      </span>
    </Field>
  );
}

/** Tutar alanındaki metni sayıya çevirir: boş "sınırsız", geçersiz metin `undefined`. */
function parseLimit(text: string): number | null | undefined {
  const clean = text.trim().replace(',', '.');
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function LimitField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field label="Aylık harcama sınırı" hint="ABD doları. Boş bırakırsanız kişisel sınır olmaz; takımın genel sınırı yine geçerlidir.">
      <span className="relative block max-w-[12rem]">
        <input
          className="input !pr-14 text-right tabular-nums"
          inputMode="decimal"
          placeholder="Sınırsız"
          value={value}
          aria-invalid={parseLimit(value) === undefined || undefined}
          onChange={(event) => onChange(event.target.value.replace(/[^\d.,]/g, '').slice(0, 9))}
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[0.8rem] text-ink-3">$ / ay</span>
      </span>
    </Field>
  );
}

/**
 * Üyeye iletilecek giriş bilgileri. Şifre bu pencere kapanınca bir daha gösterilmez;
 * üye ilk girişte kendi şifresini belirlediği için bu şifre yalnızca bir kez işe yarar.
 */
function Credentials({ address, invitePath, email, password }: { address: string; invitePath?: string | null; email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  const link = invitePath ? `${address}${invitePath}` : address;
  const text = [
    invitePath ? 'Bellek takımına davet edildin.' : 'Bellek giriş bilgilerin',
    `${invitePath ? 'Bağlantı' : 'Adres'}: ${link}`,
    `E-posta: ${email}`,
    `Geçici şifre: ${password}`,
    'İlk girişte kendi şifreni belirleyeceksin.',
  ].join('\n');
  return (
    <div>
      <Notice level="ok">Hesap hazır. Bu bilgileri üyeye iletin; şifre bu pencere kapanınca bir daha gösterilmez.</Notice>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-[12px] bg-sunken px-4 py-3.5 text-[0.92rem]">
        <dt className="text-ink-3">{invitePath ? 'Davet bağlantısı' : 'Adres'}</dt>
        <dd className="font-mono text-[0.86rem] break-all">{link}</dd>
        <dt className="text-ink-3">E-posta</dt>
        <dd className="font-mono text-[0.86rem] break-all">{email}</dd>
        <dt className="text-ink-3">Geçici şifre</dt>
        <dd className="font-mono text-[0.86rem] break-all">{password}</dd>
      </dl>
      <button
        type="button"
        className="btn btn-primary mt-4"
        onClick={async () => {
          if (await copyText(text)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } else toast('Panoya kopyalanamadı; bilgileri elle seçip kopyalayın.', 'error');
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? 'Kopyalandı' : 'Tümünü kopyala'}
      </button>
      <p className="hint mt-3">
        {invitePath
          ? 'Üye bağlantıyı açıp bu şifreyle girer; adını yazar, isterse profil resmi ekler ve kendi şifresini belirleyip takımınıza katılır.'
          : 'Üye bu şifreyle girdiğinde kendi şifresini belirlemeden devam edemez.'}
      </p>
    </div>
  );
}

// ───────────────────────── Pencereler ─────────────────────────

function AddMemberDialog({ open, onClose, grantable, address }: { open: boolean; onClose: () => void; grantable: Permission[]; address: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string; invitePath: string | null } | null>(null);

  useEffect(() => {
    if (!open) return;
    const editor = PRESETS.find((item) => item.id === 'editor')!.permissions;
    setEmail('');
    setPassword(generatePassword());
    setName('');
    setLimit('');
    setPermissions(normalizePermissions(editor.filter((permission) => grantable.includes(permission))));
    setCreated(null);
    // Yalnızca pencere açılırken sıfırlanır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = async () => {
    setBusy(true);
    const member = await attempt(() => api.post<TeamMember>('/api/team/members', { email, password, name, permissions, monthlyLimit: parseLimit(limit) ?? null }));
    setBusy(false);
    if (member) {
      setCreated({ email: member.email ?? email, password, invitePath: member.invitePath ?? null });
      refreshTeam();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={created ? 'Üye eklendi' : 'Üye ekle'}
      description={created ? undefined : 'E-postayı ve ilk şifreyi siz belirlersiniz. Üye giriş yaptığında kendi şifresini koyar ve doğrudan takımınızda olur.'}
      footer={
        created ? (
          <button type="button" className="btn btn-outline" onClick={onClose}>Kapat</button>
        ) : (
          <>
            <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
            <button type="button" className="btn btn-primary" disabled={busy || !email.trim() || password.length < 8 || parseLimit(limit) === undefined} onClick={create}>
              {busy ? <Spinner /> : <UserPlus />} Hesabı aç
            </button>
          </>
        )
      }
    >
      {created ? (
        <Credentials address={address} invitePath={created.invitePath} email={created.email} password={created.password} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="E-posta">
              <input className="input" type="email" autoFocus autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            <Field label="Ad" hint="İsteğe bağlı; boş bırakırsanız ilk girişte kendisi yazar.">
              <input className="input" autoComplete="off" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </Field>
          </div>
          <PasswordField value={password} onChange={setPassword} hint="Yalnızca ilk giriş içindir; üye girdiğinde kendi şifresini belirlemek zorundadır." />
          <LimitField value={limit} onChange={setLimit} />
          <PermissionEditor value={permissions} onChange={setPermissions} grantable={grantable} />
        </div>
      )}
    </Dialog>
  );
}

function EditMemberDialog({ member, onClose, grantable }: { member: TeamMember | null; onClose: () => void; grantable: Permission[] }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!member) return;
    setName(member.name);
    setEmail(member.email ?? '');
    setPermissions(normalizePermissions(member.permissions ?? []));
    setLimit(member.monthlyLimit ? String(member.monthlyLimit).replace('.', ',') : '');
  }, [member]);

  const save = async () => {
    if (!member) return;
    setBusy(true);
    const ok = await attempt(() => api.patch(`/api/team/members/${member.id}`, { name, email, permissions, monthlyLimit: parseLimit(limit) ?? null }), 'Üye güncellendi.');
    setBusy(false);
    if (ok) {
      refreshTeam();
      onClose();
    }
  };

  return (
    <Dialog
      open={!!member}
      onClose={onClose}
      size="lg"
      title="Üyeyi düzenle"
      description="Yetki değişiklikleri hemen geçerli olur; üyenin yeniden giriş yapması gerekmez."
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !email.trim() || parseLimit(limit) === undefined} onClick={save}>
            {busy && <Spinner />} Kaydet
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ad">
            <input className="input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="E-posta">
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
        </div>
        <LimitField value={limit} onChange={setLimit} />
        <PermissionEditor value={permissions} onChange={setPermissions} grantable={grantable} />
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({ member, onClose, address }: { member: TeamMember | null; onClose: () => void; address: string }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!member) return;
    setPassword(generatePassword());
    setDone(false);
  }, [member]);

  const save = async () => {
    if (!member) return;
    setBusy(true);
    const ok = await attempt(() => api.patch(`/api/team/members/${member.id}`, { password }));
    setBusy(false);
    if (ok) {
      setDone(true);
      refreshTeam();
    }
  };

  return (
    <Dialog
      open={!!member}
      onClose={onClose}
      size="md"
      title={done ? 'Şifre sıfırlandı' : 'Şifreyi sıfırla'}
      description={done ? undefined : `${member?.name ?? ''} için geçici bir şifre belirleyin. Açık oturumları kapanır; bu şifreyle girince kendi şifresini yeniden belirler.`}
      footer={
        done ? (
          <button type="button" className="btn btn-outline" onClick={onClose}>Kapat</button>
        ) : (
          <>
            <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
            <button type="button" className="btn btn-primary" disabled={busy || password.length < 8} onClick={save}>
              {busy ? <Spinner /> : <KeyRound />} Sıfırla
            </button>
          </>
        )
      }
    >
      {done ? (
        <Credentials address={address} invitePath={member?.invitePath} email={member?.email ?? ''} password={password} />
      ) : (
        <PasswordField value={password} onChange={setPassword} hint="Yalnızca bir sonraki giriş içindir; üye girdiğinde kendi şifresini belirlemek zorundadır." />
      )}
    </Dialog>
  );
}

// ───────────────────────── Liste ve etkinlik ─────────────────────────

function memberStatus(member: TeamMember): { text: string; tone: 'ok' | 'muted' | 'danger' } {
  if (member.disabled) return { text: 'Hesap kapalı', tone: 'danger' };
  if (!member.onboarded) return { text: 'Henüz giriş yapmadı', tone: 'muted' };
  return { text: member.lastSeenAt ? `Son görülme ${timeAgo(member.lastSeenAt)}` : 'Giriş yaptı', tone: 'ok' };
}

function AccessNotice({ team }: { team: Team }) {
  const access = team.access;
  if (!access) return null;
  if (access.local) {
    return (
      <Notice level="warn">
        Bellek şu anda yalnızca bu bilgisayardan açılıyor. Takım arkadaşlarınızın kendi bilgisayarlarından girebilmesi için sunucuyu ağa açık
        başlatın: <code className="meta">HOST=0.0.0.0 npm start</code>
      </Notice>
    );
  }
  if (!access.urls.length) return null;
  return (
    <Notice
      level="info"
      action={
        <button type="button" className="btn btn-ghost btn-sm -my-1" onClick={async () => (await copyText(access.urls[0])) && toast('Adres kopyalandı.', 'ok')}>
          <Copy /> Kopyala
        </button>
      }
    >
      Aynı ağdaki takım arkadaşlarınız şu adresten girer: <code className="meta">{access.urls[0]}</code>
    </Notice>
  );
}

function Activity() {
  const activity = useQuery({ queryKey: ['activity'], queryFn: () => api.get<ActivityEntry[]>('/api/team/activity') });
  const list = activity.data ?? [];
  if (activity.isLoading) return <div className="grid h-40 place-items-center text-ink-3"><Spinner /></div>;
  if (!list.length) return <Empty icon={<History />} title="Henüz etkinlik yok" body="Girişler, silmeler, yetki ve anahtar değişiklikleri burada birikir." />;
  return (
    <ul className="divide-y divide-line border-y border-line">
      {list.map((entry) => (
        <li key={entry.id} className="flex items-baseline gap-4 py-2.5">
          <span className="min-w-0 flex-1 text-[0.92rem] leading-snug">
            <span className="font-medium">{entry.userName || 'Bilinmeyen'}</span> <span className="text-ink-2">{entry.summary}</span>
          </span>
          <time className="note flex-none whitespace-nowrap" dateTime={entry.at} title={dateTime(entry.at)}>
            {timeAgo(entry.at)}
          </time>
        </li>
      ))}
    </ul>
  );
}

export function TeamSection() {
  const me = useMe();
  const manager = useCan('team.manage');
  const team = useTeam();
  const [tab, setTab] = useState<'members' | 'activity'>('members');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [resetting, setResetting] = useState<TeamMember | null>(null);
  const [name, setName] = useState('');
  useEffect(() => setName(team.data?.name ?? ''), [team.data?.name]);

  if (!team.data) return <div className="grid h-40 place-items-center text-ink-3"><Spinner /></div>;
  const data = team.data;
  const grantable = me.role === 'owner' ? ALL_PERMISSIONS : me.permissions;
  const address = data.access?.urls[0] ?? window.location.origin;

  /** Sunucudaki kuralın aynısı: sahibe ve kendine dokunulmaz, daha yetkili üye yönetilemez. */
  const manageable = (member: TeamMember) =>
    manager && member.role !== 'owner' && member.id !== me.id &&
    (me.role === 'owner' || (member.permissions ?? []).every((permission) => me.permissions.includes(permission)));

  const rename = async () => {
    const clean = name.trim();
    if (!clean || clean === data.name) return setName(data.name);
    if (await attempt(() => api.patch('/api/team', { name: clean }), 'Takım adı güncellendi.')) refreshTeam();
  };

  const setDisabled = async (member: TeamMember, disabled: boolean) => {
    if (disabled) {
      const yes = await confirmDialog({
        title: `${member.name} adlı üyenin hesabı kapatılsın mı?`,
        body: 'Açık oturumları hemen kapanır ve yeniden giriş yapamaz. Ürettiği her şey yerinde kalır; hesabı istediğiniz zaman yeniden açabilirsiniz.',
        confirm: 'Hesabı kapat',
        danger: true,
      });
      if (!yes) return;
    }
    if (await attempt(() => api.patch(`/api/team/members/${member.id}`, { disabled }), disabled ? 'Hesap kapatıldı.' : 'Hesap yeniden açıldı.')) refreshTeam();
  };

  const remove = async (member: TeamMember) => {
    const yes = await confirmDialog({
      title: `${member.name} takımdan çıkarılsın mı?`,
      body: 'Hesabı silinir ve bir daha giriş yapamaz. Sohbetleri size devredilir; hafızaya, kütüphaneye ve içeriklere eklediği her şey yerinde kalır.',
      confirm: 'Takımdan çıkar',
      danger: true,
    });
    if (!yes) return;
    if (await attempt(() => api.del(`/api/team/members/${member.id}`), 'Üye takımdan çıkarıldı.')) refreshTeam();
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-[14rem] flex-1">
          {manager ? (
            <label className="block max-w-[22rem]">
              <span className="label">Takım adı</span>
              <input
                className="input"
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => void rename()}
                onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
              />
            </label>
          ) : (
            <>
              <h2 className="text-[1.08rem] font-semibold">{data.name || 'Takım'}</h2>
              <p className="hint mt-0.5">{data.members.length} üye</p>
            </>
          )}
        </div>
        {manager && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <UserPlus /> Üye ekle
          </button>
        )}
      </div>

      {manager && (
        <div className="mb-6">
          <AccessNotice team={data} />
        </div>
      )}

      {manager && (
        <div className="mb-4">
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'members', label: `Üyeler · ${data.members.length}`, icon: <Users /> },
              { value: 'activity', label: 'Etkinlik', icon: <History /> },
            ]}
          />
        </div>
      )}

      {tab === 'activity' && manager ? (
        <Activity />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {data.members.map((member) => {
            const status = memberStatus(member);
            const editable = manageable(member);
            return (
              <li key={member.id} className={cx('flex items-center gap-3.5 py-3', member.disabled && 'opacity-60')}>
                <UserAvatar user={member} size={38} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 text-[0.95rem] font-medium">
                    <span className="truncate">{member.name}</span>
                    {member.id === me.id && <span className="badge">Siz</span>}
                  </span>
                  <span className="note block truncate">
                    {manager && member.email ? `${member.email} · ` : ''}
                    {manager ? (
                      <span className={cx(status.tone === 'danger' && 'text-danger')}>{status.text}</span>
                    ) : member.role === 'owner' ? (
                      'Takım sahibi'
                    ) : member.id === me.id ? (
                      roleName(me)
                    ) : (
                      'Üye'
                    )}
                  </span>
                </span>
                {manager && (
                  <span
                    className={cx(
                      'flex flex-none items-center gap-1.5 text-[0.84rem] whitespace-nowrap max-sm:hidden',
                      member.role === 'owner' ? 'font-medium text-ink' : 'text-ink-2',
                    )}
                    title={member.role === 'owner' ? 'Her yetkiye sahiptir' : `${(member.permissions ?? []).length} / ${ALL_PERMISSIONS.length} yetki`}
                  >
                    {member.role === 'owner' && <ShieldCheck className="h-4 w-4 text-accent-text" />}
                    {roleName(member)}
                  </span>
                )}
                {editable ? (
                  <Menu
                    trigger={(props) => (
                      <IconButton label={`${member.name}: seçenekler`} size="sm" {...props}>
                        <MoreHorizontal />
                      </IconButton>
                    )}
                    items={[
                      { label: 'Yetkileri düzenle', icon: <SlidersHorizontal />, onSelect: () => setEditing(member) },
                      {
                        label: 'Davet bağlantısını kopyala',
                        icon: <Link2 />,
                        hidden: !member.invitePath,
                        onSelect: async () =>
                          (await copyText(`${address}${member.invitePath}`))
                            ? toast('Davet bağlantısı kopyalandı. Üye, verdiğiniz şifreyle bu bağlantıdan girer.', 'ok')
                            : toast('Panoya kopyalanamadı.', 'error'),
                      },
                      { label: 'Şifreyi sıfırla', icon: <KeyRound />, onSelect: () => setResetting(member) },
                      member.disabled
                        ? { label: 'Hesabı yeniden aç', icon: <UserRoundCheck />, onSelect: () => void setDisabled(member, false) }
                        : { label: 'Hesabı kapat', icon: <UserRoundX />, onSelect: () => void setDisabled(member, true) },
                      'divider',
                      { label: 'Takımdan çıkar', icon: <UserMinus />, danger: true, onSelect: () => void remove(member) },
                    ]}
                  />
                ) : (
                  manager && <span className="w-[1.9rem] flex-none" />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {manager && tab === 'members' && data.members.length === 1 && (
        <p className="hint mt-4 max-w-[40rem]">
          Şimdilik tek kişisiniz. <strong className="font-medium text-ink-2">Üye ekle</strong> ile bir e-posta ve ilk şifre tanımlayın; o kişi davet
          bağlantısından girip adını yazar, kendi şifresini belirler ve doğrudan bu takıma katılır. Neyi görüp neyi silebileceğini yetkilerle siz belirlersiniz.
        </p>
      )}

      <AddMemberDialog open={adding} onClose={() => setAdding(false)} grantable={grantable} address={address} />
      <EditMemberDialog member={editing} onClose={() => setEditing(null)} grantable={grantable} />
      <ResetPasswordDialog member={resetting} onClose={() => setResetting(null)} address={address} />
    </>
  );
}
