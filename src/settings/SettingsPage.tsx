import {
  Archive, Bot, Database, Download, FolderOpen, Gauge, HardDriveDownload, RotateCcw, ShieldAlert, ShieldCheck,
  SlidersHorizontal, Trash2, Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { ASPECTS } from '../../shared/platforms.ts';
import type { BackupStatus, ModelKind, Settings, TrashItem } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { bytes, compact, cx, dateTime, timeAgo, usd } from '../lib/format.ts';
import { keys, queryClient, refreshApp, useApp, useBackup, useTrash, useUsage } from '../lib/queries.ts';
import { attempt, confirmDialog, toast, useUI, type Theme } from '../lib/store.ts';
import { Empty, Notice, PageHeader, Segmented, SettingRow, Spinner, Switch } from '../ui/kit.tsx';
import { ProvidersSection } from './Providers.tsx';

const SECTIONS = [
  { id: 'yapay-zeka', label: 'Yapay zekâlar', icon: Bot },
  { id: 'genel', label: 'Genel', icon: SlidersHorizontal },
  { id: 'veri', label: 'Veri ve yedekleme', icon: Database },
  { id: 'cop', label: 'Çöp kutusu', icon: Trash2 },
  { id: 'kullanim', label: 'Kullanım', icon: Gauge },
];

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-9">
      <h2 className="text-[1.08rem] font-semibold">{title}</h2>
      <div className="mt-1 divide-y divide-line border-b border-line">{children}</div>
    </section>
  );
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = await attempt(() => api.patch<Settings>('/api/settings', patch));
  if (next) queryClient.setQueryData(keys.bootstrap, (app: object | undefined) => (app ? { ...app, settings: next } : app));
}

function ModelDefault({ kind, slot, title, description }: { kind: ModelKind; slot: keyof Settings['defaults']; title: string; description: string }) {
  const app = useApp();
  const models = app.models.filter((m) => m.model.kind === kind);
  const value = app.settings.defaults[slot];
  return (
    <SettingRow title={title} description={description}>
      <select
        className="input !w-[17rem] max-w-full"
        aria-label={title}
        value={value && models.some((m) => m.ref === value) ? value : ''}
        disabled={!models.length}
        onChange={(event) => void saveSettings({ defaults: { ...app.settings.defaults, [slot]: event.target.value || null } })}
      >
        <option value="">{models.length ? `Otomatik · ${models[0].model.label}` : 'Bağlı model yok'}</option>
        {models.map((model) => (
          <option key={model.ref} value={model.ref}>
            {model.model.label} — {model.providerName}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

function GeneralSection() {
  const app = useApp();
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const generation = app.settings.generation;
  const [instructions, setInstructions] = useState(app.settings.customInstructions);
  useEffect(() => setInstructions(app.settings.customInstructions), [app.settings.customInstructions]);
  const setGeneration = (patch: Partial<Settings['generation']>) => void saveSettings({ generation: { ...generation, ...patch } });

  return (
    <>
      <Group title="Görünüm">
        <SettingRow title="Tema" description="Sistem ayarını izleyebilir ya da sabit bir tema seçebilirsiniz.">
          <Segmented<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: 'Sistem' },
              { value: 'light', label: 'Açık' },
              { value: 'dark', label: 'Koyu' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group title="Varsayılan modeller">
        <ModelDefault kind="text" slot="text" title="Metin ve yönetmen" description="Sohbeti yürütür, istemleri yazar, gönderileri hazırlar." />
        <ModelDefault kind="text" slot="utility" title="Hızlı işler" description="Sohbet başlığı ve etiket önerisi gibi küçük işler. Ekonomik bir model seçin." />
        <ModelDefault kind="image" slot="image" title="Görsel" description="Görsel üretimi ve video için anahtar kare." />
        <ModelDefault kind="video" slot="video" title="Video" description="Metinden, görselden ya da referanslardan video." />
      </Group>

      <Group title="Üretim">
        <SettingRow title="Varsayılan oran" description="Stüdyoda her istek için ayrıca değiştirebilirsiniz.">
          <select className="input !w-44" aria-label="Varsayılan oran" value={generation.aspect} onChange={(event) => setGeneration({ aspect: event.target.value })}>
            {ASPECTS.map((aspect) => (
              <option key={aspect.id} value={aspect.id}>
                {aspect.id} · {aspect.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="Seçenek sayısı" description="Her görsel isteğinde kaç alternatif üretilsin.">
          <Segmented value={String(generation.count)} onChange={(value) => setGeneration({ count: Number(value) })} options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))} />
        </SettingRow>
        <SettingRow title="Kişi başına referans" description="Bir kişi ya da ürün anıldığında en fazla kaç fotoğrafı gönderilsin. Fazlası benzerliği artırır, maliyeti de.">
          <Segmented value={String(generation.refsPerEntity)} onChange={(value) => setGeneration({ refsPerEntity: Number(value) })} options={['1', '2', '3', '4', '5', '6'].map((n) => ({ value: n, label: n }))} />
        </SettingRow>
        <SettingRow title="İstemleri zenginleştir" description="Görsel ve video kiplerinde isteğiniz, hafızadaki bilgilerle ayrıntılı bir isteme dönüştürülür.">
          <Switch checked={generation.enhance} label="İstemleri zenginleştir" onChange={(enhance) => setGeneration({ enhance })} />
        </SettingRow>
      </Group>

      <Group title="Hafıza">
        <SettingRow title="Sohbetlerden öğren" description="“Bundan sonra…”, “asla…” gibi kalıcı tercihleri Bellek kendiliğinden not alır. Her not sohbette görünür ve tek tıkla unutturulabilir.">
          <Switch checked={generation.autoMemory} label="Sohbetlerden öğren" onChange={(autoMemory) => setGeneration({ autoMemory })} />
        </SettingRow>
        <div className="py-4">
          <div className="text-[0.95rem] font-medium">Kalıcı yönerge</div>
          <p className="hint mt-0.5 mb-2.5 max-w-[40rem]">Her sohbette geçerli olacak genel kurallar. Kişiye ve markaya özel olanları kendi sayfalarına yazın.</p>
          <textarea
            className="input max-w-[44rem]"
            rows={4}
            aria-label="Kalıcı yönerge"
            placeholder="Örn. Bize “siz” diye hitap et. Metinlerde İngilizce terim kullanma. Görsellerde stok fotoğraf havasından kaçın."
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onBlur={() => instructions !== app.settings.customInstructions && void saveSettings({ customInstructions: instructions })}
          />
        </div>
      </Group>
    </>
  );
}

function DataSection() {
  const app = useApp();
  const backup = useBackup();
  const status = backup.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [mirror, setMirror] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => setMirror(app.settings.backup.mirrorDir), [app.settings.backup.mirrorDir]);

  const apply = (next: BackupStatus) => queryClient.setQueryData(keys.backup, next);

  const run = async () => {
    setBusy('run');
    const next = await attempt(() => api.post<BackupStatus>('/api/backup/run'), 'Yedek alındı.');
    setBusy(null);
    if (next) apply(next);
  };

  const restore = async (name: string, when: string) => {
    const yes = await confirmDialog({
      title: 'Bu yedeğe dönülsün mü?',
      body: `Veritabanı ${dateTime(when)} tarihindeki hâline döner. Şimdiki hâl önce ayrıca yedeklenir; görseller ve videolar etkilenmez.`,
      confirm: 'Geri yükle',
      danger: true,
    });
    if (!yes) return;
    setBusy(name);
    const next = await attempt(() => api.post<BackupStatus>('/api/backup/restore', { name }), 'Yedek geri yüklendi.');
    setBusy(null);
    if (next) {
      apply(next);
      await queryClient.invalidateQueries();
    }
  };

  const importZip = async (file: File) => {
    const yes = await confirmDialog({
      title: 'Arşiv içe aktarılsın mı?',
      body: 'Arşivdeki veritabanı şimdikinin yerine geçer, görseller eklenir. Şimdiki hâl önce yedeklenir.',
      confirm: 'İçe aktar',
      danger: true,
    });
    if (!yes) return;
    setBusy('import');
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/backup/import', { method: 'POST', body: form });
      const body = (await response.json()) as { error?: string; media?: number };
      if (!response.ok) throw new Error(body.error ?? 'İçe aktarılamadı.');
      toast(`Arşiv içe aktarıldı. ${body.media ?? 0} yeni dosya eklendi.`, 'ok');
      await queryClient.invalidateQueries();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'İçe aktarılamadı.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const setBackup = (patch: Partial<Settings['backup']>) => saveSettings({ backup: { ...app.settings.backup, ...patch } });

  if (!status) return <div className="grid h-40 place-items-center text-ink-3"><Spinner /></div>;
  const healthy = status.integrity !== 'error';

  return (
    <>
      <div className={cx('mb-8 flex flex-wrap items-center gap-x-6 gap-y-4 rounded-[14px] p-5', healthy ? 'bg-ok-soft' : 'bg-danger-soft')}>
        {healthy ? <ShieldCheck className="h-9 w-9 flex-none text-ok" /> : <ShieldAlert className="h-9 w-9 flex-none text-danger" />}
        <div className="min-w-[14rem] flex-1">
          <div className={cx('text-[1.05rem] font-semibold', healthy ? 'text-ok' : 'text-danger')}>
            {healthy ? 'Verileriniz bu bilgisayarda ve güvende' : 'Veritabanı bütünlük denetiminden geçemedi'}
          </div>
          <p className="mt-0.5 text-[0.9rem] text-ink-2">
            {healthy
              ? `Son yedek ${status.lastBackupAt ? timeAgo(status.lastBackupAt) : 'henüz alınmadı'} · ${status.backups.length} anlık kopya saklanıyor${status.mirrorDir ? ` · ayna ${status.lastMirrorAt ? timeAgo(status.lastMirrorAt) : 'bekliyor'}` : ''}`
              : 'Aşağıdaki son sağlam yedeğe dönmeniz önerilir. Görselleriniz etkilenmez.'}
          </p>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy === 'run'} onClick={run}>
          {busy === 'run' ? <Spinner /> : <HardDriveDownload />} Şimdi yedekle
        </button>
      </div>

      <Group title="Nerede saklanıyor">
        <SettingRow
          title="Veri klasörü"
          description={
            <>
              <span className="meta break-all">{status.dataDir}</span>
              <br />
              Proje klasörünün dışındadır; kodu silmek ya da güncellemek hafızaya dokunmaz. Veritabanı {bytes(status.dbSize)}, {status.mediaCount} medya dosyası {bytes(status.mediaSize)}.
            </>
          }
        >
          <button type="button" className="btn btn-outline" onClick={() => void attempt(() => api.post('/api/backup/reveal'))}>
            <FolderOpen /> Klasörü aç
          </button>
        </SettingRow>
      </Group>

      <Group title="Otomatik yedekleme">
        <SettingRow title="Sıklık" description="Veritabanının tutarlı bir anlık kopyası alınır. Silinen her şey ayrıca çöp kutusunda bekler.">
          <select className="input !w-44" aria-label="Yedekleme sıklığı" value={app.settings.backup.intervalHours} onChange={(event) => void setBackup({ intervalHours: Number(event.target.value) })}>
            <option value={1}>Saatte bir</option>
            <option value={6}>6 saatte bir</option>
            <option value={12}>12 saatte bir</option>
            <option value={24}>Günde bir</option>
          </select>
        </SettingRow>
        <SettingRow title="Saklanacak kopya" description="En eski otomatik kopyalar bu sayının üstünde silinir.">
          <select className="input !w-44" aria-label="Saklanacak kopya sayısı" value={app.settings.backup.keep} onChange={(event) => void setBackup({ keep: Number(event.target.value) })}>
            {[10, 30, 60, 120].map((n) => (
              <option key={n} value={n}>{n} kopya</option>
            ))}
          </select>
        </SettingRow>
        <div className="py-4">
          <div className="text-[0.95rem] font-medium">Ayna klasör</div>
          <p className="hint mt-0.5 mb-2.5 max-w-[42rem]">
            İkinci bir konum (harici disk, iCloud Drive, Dropbox…). Her yedekte veritabanı kopyası ve tüm medya buraya da eşitlenir; disk arızasına karşı asıl korumadır.
          </p>
          <div className="flex max-w-[44rem] flex-wrap gap-2">
            <input
              className="input min-w-60 flex-1 font-mono !text-[0.84rem]"
              aria-label="Ayna klasör yolu"
              placeholder="~/Library/Mobile Documents/com~apple~CloudDocs/Bellek Yedek"
              value={mirror}
              onChange={(event) => setMirror(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-outline"
              disabled={mirror === app.settings.backup.mirrorDir}
              onClick={async () => {
                await setBackup({ mirrorDir: mirror.trim() });
                if (mirror.trim()) await run();
                else void queryClient.invalidateQueries({ queryKey: keys.backup });
              }}
            >
              Kaydet ve eşitle
            </button>
          </div>
          {status.mirrorError && <div className="mt-3 max-w-[44rem]"><Notice level="error">Ayna klasöre yazılamadı: {status.mirrorError}</Notice></div>}
        </div>
      </Group>

      <Group title="Taşıma">
        <SettingRow title="Tümünü dışa aktar" description="Veritabanı ve tüm medya tek bir ZIP dosyası olarak iner. API anahtarları dahil edilmez.">
          <a href="/api/backup/export" className="btn btn-outline" download>
            <Download /> ZIP indir
          </a>
        </SettingRow>
        <SettingRow title="Arşivden içe aktar" description="Başka bir bilgisayardaki Bellek'ten aldığınız ZIP dosyasını buraya taşır.">
          <button type="button" className="btn btn-outline" disabled={busy === 'import'} onClick={() => importInput.current?.click()}>
            {busy === 'import' ? <Spinner /> : <Upload />} ZIP seç
          </button>
          <input
            ref={importInput}
            type="file"
            hidden
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importZip(file);
              event.target.value = '';
            }}
          />
        </SettingRow>
      </Group>

      <section>
        <h2 className="text-[1.08rem] font-semibold">Anlık kopyalar</h2>
        {status.backups.length ? (
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {status.backups.slice(0, 40).map((file) => (
              <li key={file.name} className="flex items-center gap-4 py-2.5">
                <Archive className="h-4 w-4 flex-none text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.92rem]">{dateTime(file.createdAt)}</span>
                  <span className="note">{file.reason} · {bytes(file.size)}</span>
                </span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void restore(file.name, file.createdAt)}>
                  {busy === file.name ? <Spinner /> : <RotateCcw />} Geri yükle
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[0.9rem] text-ink-3">Henüz yedek alınmadı.</p>
        )}
      </section>
    </>
  );
}

const TRASH_LABEL: Record<TrashItem['kind'], string> = {
  asset: 'Görsel', entity: 'Hafıza kaydı', conversation: 'Sohbet', post: 'Gönderi', memory: 'Not', design: 'Tasarım',
};

function TrashSection() {
  const trash = useTrash();
  const items = trash.data ?? [];
  const apply = (next: TrashItem[]) => {
    queryClient.setQueryData(keys.trash, next);
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    void refreshApp();
  };

  const restore = async (item: TrashItem) => {
    const next = await attempt(() => api.post<TrashItem[]>('/api/trash/restore', { kind: item.kind, id: item.id }), 'Geri getirildi.');
    if (next) apply(next);
  };
  const purge = async (item: TrashItem) => {
    const yes = await confirmDialog({ title: 'Kalıcı olarak silinsin mi?', body: `“${item.title}” geri getirilemeyecek biçimde silinir.`, confirm: 'Kalıcı olarak sil', danger: true });
    if (!yes) return;
    const next = await attempt(() => api.post<TrashItem[]>('/api/trash/purge', { kind: item.kind, id: item.id }));
    if (next) apply(next);
  };
  const empty = async () => {
    const yes = await confirmDialog({
      title: 'Çöp kutusu boşaltılsın mı?',
      body: `${items.length} öğe kalıcı olarak silinir. Öncesinde veritabanının bir yedeği alınır, ancak silinen görsel dosyaları geri gelmez.`,
      confirm: 'Çöpü boşalt',
      danger: true,
    });
    if (!yes) return;
    const next = await attempt(() => api.post<TrashItem[]>('/api/trash/empty'), 'Çöp kutusu boşaltıldı.');
    if (next) apply(next);
  };

  if (trash.isLoading) return <div className="grid h-40 place-items-center text-ink-3"><Spinner /></div>;
  if (!items.length) {
    return <Empty icon={<Trash2 />} title="Çöp kutusu boş" body="Sildiğiniz hiçbir şey hemen yok olmaz: buraya gelir ve siz kalıcı olarak silene kadar bekler." />;
  }
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[40rem] text-[0.93rem] text-ink-2">Silinen öğeler burada bekler. Geri getirebilir ya da kalıcı olarak silebilirsiniz.</p>
        <button type="button" className="btn btn-danger btn-sm" onClick={empty}>
          <Trash2 /> Çöpü boşalt
        </button>
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {items.map((item) => (
          <li key={`${item.kind}${item.id}`} className="flex items-center gap-3.5 py-2.5">
            {item.thumbUrl ? (
              <img src={item.thumbUrl} alt="" className="h-11 w-11 flex-none rounded-lg bg-sunken object-cover" loading="lazy" />
            ) : (
              <span className="grid h-11 w-11 flex-none place-items-center rounded-lg bg-sunken text-[0.7rem] font-medium text-ink-3">{TRASH_LABEL[item.kind].slice(0, 3)}</span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.93rem]">{item.title}</span>
              <span className="note">{TRASH_LABEL[item.kind]} · {timeAgo(item.deletedAt)} silindi</span>
            </span>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void restore(item)}>
              <RotateCcw /> Geri getir
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm !text-danger" aria-label="Kalıcı olarak sil" title="Kalıcı olarak sil" onClick={() => void purge(item)}>
              <Trash2 />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

const KIND_LABEL: Record<string, string> = { text: 'Metin', image: 'Görsel', video: 'Video' };

function parseAmount(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}

function amountText(value: number | undefined | null): string {
  return value === undefined || value === null ? '' : String(value).replace('.', ',');
}

/** Küçük tutar alanı: odaktan çıkınca kaydeder, boş bırakılırsa değeri kaldırır. */
function AmountInput({ value, placeholder, label, suffix, onCommit, className }: {
  value: number | undefined | null;
  placeholder?: string;
  label: string;
  suffix: string;
  onCommit: (value: number | null) => void;
  className?: string;
}) {
  const [text, setText] = useState(amountText(value));
  useEffect(() => setText(amountText(value)), [value]);
  const commit = () => {
    const next = parseAmount(text);
    if (text.trim() !== '' && next === null) return setText(amountText(value));
    if (next !== (value ?? null)) onCommit(next);
  };
  return (
    <span
      className={cx(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 align-middle transition-[border-color,box-shadow] duration-150',
        'hover:border-line-strong focus-within:border-accent-text focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_22%,transparent)]',
        className,
      )}
    >
      <input
        className="min-w-0 flex-1 bg-transparent text-right font-mono text-[0.82rem] tabular-nums outline-none placeholder:text-ink-3"
        inputMode="decimal"
        aria-label={label}
        title={label}
        placeholder={placeholder ?? '—'}
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^\d.,]/g, '').slice(0, 9))}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />
      <span className="pointer-events-none flex-none text-[0.7rem] whitespace-nowrap text-ink-3">{suffix}</span>
    </span>
  );
}

interface UsageLine {
  ref: string;
  provider: string;
  model: string;
  kind: string;
  requests: number;
  input: number;
  output: number;
  units: number;
  cost: number | null;
}

function UsageSection() {
  const app = useApp();
  const [days, setDays] = useState(30);
  const usage = useUsage(days);
  const report = usage.data;
  const rows = report?.rows ?? [];

  const byModel = new Map<string, UsageLine>();
  for (const row of rows) {
    const key = `${row.provider}:${row.model}:${row.kind}`;
    const entry = byModel.get(key) ?? { ref: `${row.provider}:${row.model}`, provider: row.provider, model: row.model, kind: row.kind, requests: 0, input: 0, output: 0, units: 0, cost: 0 };
    entry.requests += row.requests;
    entry.input += row.inputTokens;
    entry.output += row.outputTokens;
    entry.units += row.units;
    entry.cost = entry.cost === null || row.cost === null ? null : entry.cost + row.cost;
    byModel.set(key, entry);
  }
  const list = [...byModel.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.requests - a.requests);
  const providerName = (id: string) => app.providers.find((p) => p.id === id)?.name ?? id;
  const modelLabel = (ref: string) => app.providers.flatMap((p) => p.models.map((m) => ({ ref: `${p.id}:${m.id}`, label: m.label }))).find((m) => m.ref === ref)?.label;
  const rangeTotal = list.reduce((sum, row) => sum + (row.cost ?? 0), 0);

  const budget = report?.budget ?? app.settings.budget;
  const limit = budget.monthlyLimit;
  const spend = report?.monthSpend ?? 0;
  const ratio = limit ? Math.min(1, spend / limit) : 0;

  const saveBudget = async (patch: Partial<Settings['budget']>) => {
    await saveSettings({ budget: { ...budget, ...patch } });
    void queryClient.invalidateQueries({ queryKey: ['usage'] });
  };

  const setPrice = (ref: string, field: 'input' | 'output' | 'unit', value: number | null) => {
    // Kullanıcının girdiği değer liste fiyatının üzerine yazılır; diğer alanlar korunur.
    const base = { ...report?.prices[ref], ...budget.prices[ref] };
    const next = { ...base, [field]: value ?? undefined };
    const prices = { ...budget.prices, [ref]: next };
    if (next.input === undefined && next.output === undefined && next.unit === undefined) delete prices[ref];
    void saveBudget({ prices });
  };

  return (
    <>
      <section className="mb-8" aria-label="Bütçe">
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div className="min-w-[16rem] flex-1">
            <h2 className="text-[1.08rem] font-semibold">Bu ayın harcaması</h2>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[0.93rem] text-ink-2">
              <span className="text-[1.5rem] leading-none font-semibold text-ink tabular-nums">{usd(spend)}</span>
              {limit ? `/ ${usd(limit)} sınırın %${Math.round((spend / limit) * 100)}'i` : 'tahmini · sınır yok'}
            </p>
            {limit !== null && (
              <div className="mt-3 h-1.5 max-w-[26rem] overflow-hidden rounded-full bg-sunken" role="meter" aria-label="Aylık sınırın kullanılan kısmı" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(spend, limit)}>
                <div className={cx('h-full rounded-full transition-[width] duration-300', ratio >= 1 ? 'bg-danger' : ratio >= 0.8 ? 'bg-warn' : 'bg-ink')} style={{ width: `${Math.max(ratio * 100, spend > 0 ? 2 : 0)}%` }} />
              </div>
            )}
          </div>
          <label className="block w-44">
            <span className="label">Aylık sınır</span>
            <AmountInput className="w-full" label="Aylık harcama sınırı (ABD doları)" suffix="$ / ay" placeholder="Sınır yok" value={limit} onCommit={(value) => void saveBudget({ monthlyLimit: value && value > 0 ? value : null })} />
          </label>
        </div>
        <p className="hint mt-3 max-w-[44rem]">
          Tutarlar, aşağıdaki birim fiyatlarla Bellek üzerinden yapılan çağrılardan hesaplanan tahmindir; kesin fatura sağlayıcının panelindedir. Sınıra ulaşılınca yeni üretimler durur, siz sınırı yükseltene ya da kaldırana kadar başlamaz.
        </p>
        {limit !== null && ratio >= 1 && (
          <div className="mt-3"><Notice level="error">Aylık sınıra ulaşıldı; yeni üretimler başlatılmıyor. Sürdürmek için sınırı yükseltin ya da alanı boşaltın.</Notice></div>
        )}
        {(report?.unpriced.length ?? 0) > 0 && (
          <div className="mt-3">
            <Notice level="warn">
              Fiyatı bilinmeyen {report!.unpriced.length} model bu ayın toplamına katılmıyor: {report!.unpriced.map((ref) => modelLabel(ref) ?? ref.split(':').slice(1).join(':')).join(', ')}. Aşağıdaki tabloda birim fiyatını girin.
            </Notice>
          </div>
        )}
      </section>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[1.08rem] font-semibold">Model başına döküm</h2>
        <Segmented size="sm" value={String(days)} onChange={(value) => setDays(Number(value))} options={[{ value: '7', label: '7 gün' }, { value: '30', label: '30 gün' }, { value: '90', label: '90 gün' }]} />
      </div>

      {usage.isLoading ? (
        <div className="grid h-40 place-items-center text-ink-3"><Spinner /></div>
      ) : !list.length ? (
        <Empty icon={<Gauge />} title="Bu aralıkta kullanım yok" body="Üretim yaptıkça model başına istek, kullanım ve tahmini tutar burada birikir." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-[0.9rem]">
            <thead>
              <tr className="border-b border-line text-left text-[0.8rem] text-ink-3">
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 pr-4 text-right font-medium">İstek</th>
                <th className="py-2 pr-4 font-medium">Kullanım</th>
                <th className="py-2 pr-4 font-medium">Birim fiyat</th>
                <th className="py-2 text-right font-medium">Tutar</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => {
                const listed = report?.prices[row.ref];
                const own = budget.prices[row.ref];
                return (
                  <tr key={`${row.ref}${row.kind}`} className="border-b border-line align-middle">
                    <td className="py-2.5 pr-4">
                      <span className="block">{modelLabel(row.ref) ?? row.model}</span>
                      <span className="text-[0.8rem] text-ink-3">{providerName(row.provider)} · {KIND_LABEL[row.kind] ?? row.kind}</span>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{row.requests}</td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-ink-2 tabular-nums">
                      {row.kind === 'text' ? `${compact(row.input)} girdi · ${compact(row.output)} çıktı` : row.kind === 'video' ? `${row.units} sn` : `${row.units} görsel`}
                    </td>
                    <td className="py-2 pr-4">
                      {row.kind === 'text' ? (
                        <span className="flex gap-1.5">
                          <AmountInput className="w-[6.6rem]" label="1 milyon girdi belirteci fiyatı (ABD doları)" suffix="girdi" placeholder={amountText(listed?.input) || '—'} value={own?.input} onCommit={(value) => setPrice(row.ref, 'input', value)} />
                          <AmountInput className="w-[6.6rem]" label="1 milyon çıktı belirteci fiyatı (ABD doları)" suffix="çıktı" placeholder={amountText(listed?.output) || '—'} value={own?.output} onCommit={(value) => setPrice(row.ref, 'output', value)} />
                        </span>
                      ) : (
                        <AmountInput
                          className="w-[8rem]"
                          label={row.kind === 'video' ? 'Saniye başına fiyat (ABD doları)' : 'Görsel başına fiyat (ABD doları)'}
                          suffix={row.kind === 'video' ? '$ / sn' : '$ / adet'}
                          placeholder={amountText(listed?.unit) || '—'}
                          value={own?.unit}
                          onCommit={(value) => setPrice(row.ref, 'unit', value)}
                        />
                      )}
                    </td>
                    <td className={cx('py-2.5 text-right tabular-nums', row.cost === null && 'text-ink-3')}>{row.cost === null ? 'fiyat yok' : usd(row.cost)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="py-2.5 pr-4 text-right text-[0.84rem] text-ink-3">Son {days} günün tahmini toplamı</td>
                <td className="py-2.5 text-right font-semibold tabular-nums">{usd(rangeTotal)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="hint mt-2">Metin fiyatları 1 milyon belirteç başınadır. Boş alanlarda soluk yazan değer liste fiyatıdır; kendi anlaşmanız farklıysa üzerine yazın.</p>
        </div>
      )}
    </>
  );
}

export default function SettingsPage() {
  const { section = 'yapay-zeka' } = useParams();
  const app = useApp();
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Ayarlar" subtitle={`Bellek ${app.app.version}${app.app.mock ? ' · deneme sağlayıcısı açık' : ''}`}>
        <nav className="-mb-px flex gap-5 overflow-x-auto" aria-label="Ayar bölümleri">
          {SECTIONS.map((item) => (
            <NavLink
              key={item.id}
              to={`/ayarlar/${item.id}`}
              className={cx(
                'flex items-center gap-1.5 border-b-2 pb-2.5 text-[0.93rem] font-medium whitespace-nowrap transition-colors',
                item.id === active.id ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink',
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
              {item.id === 'cop' && app.counts.trash > 0 && <span className="meta">{app.counts.trash}</span>}
            </NavLink>
          ))}
        </nav>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[56rem] px-6 py-7 max-md:px-4">
          {active.id === 'yapay-zeka' && <ProvidersSection />}
          {active.id === 'genel' && <GeneralSection />}
          {active.id === 'veri' && <DataSection />}
          {active.id === 'cop' && <TrashSection />}
          {active.id === 'kullanim' && <UsageSection />}
        </div>
      </div>
    </div>
  );
}
