import { Globe, Pipette, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrandColor, BrandColorRole, EntityData, EntityDetail } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { keys, queryClient } from '../lib/queries.ts';
import { attempt, toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Field, IconButton, Spinner } from '../ui/kit.tsx';
import { extractPalette } from './palette.ts';

const ROLES: { id: BrandColorRole; label: string }[] = [
  { id: 'primary', label: 'Ana' },
  { id: 'secondary', label: 'İkincil' },
  { id: 'accent', label: 'Vurgu' },
  { id: 'neutral', label: 'Nötr' },
  { id: 'background', label: 'Zemin' },
  { id: 'text', label: 'Metin' },
];

const TEXT_FIELDS: { key: 'tagline' | 'industry' | 'audience' | 'website'; label: string; placeholder: string }[] = [
  { key: 'tagline', label: 'Slogan', placeholder: 'Her yudumda özen' },
  { key: 'industry', label: 'Sektör', placeholder: 'Butik kahve' },
  { key: 'audience', label: 'Hedef kitle', placeholder: '25–40 yaş, şehirli profesyoneller' },
  { key: 'website', label: 'Web sitesi', placeholder: 'acmekahve.com' },
];

const LONG_FIELDS: { key: 'tone' | 'values' | 'dos' | 'donts'; label: string; placeholder: string }[] = [
  { key: 'tone', label: 'Ses tonu', placeholder: 'Sıcak ve kendinden emin; kısa cümleler, abartısız. “Siz” diye hitap eder.' },
  { key: 'values', label: 'Değerler', placeholder: 'Zanaat, şeffaflık, yerel üretici' },
  { key: 'dos', label: 'Her zaman', placeholder: 'Ürünün kökenini an. Somut ayrıntı ver.' },
  { key: 'donts', label: 'Asla', placeholder: 'Ünlem, “en iyi” gibi iddialar, indirim dili.' },
];

function ExtractDialog({ entity, open, onClose }: { entity: EntityDetail; open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const detail = await attempt(() => api.post<EntityDetail>(`/api/entities/${entity.id}/brand-extract`, { text }), 'Marka kimliği dolduruldu.');
    setBusy(false);
    if (detail) {
      queryClient.setQueryData(keys.entity(entity.id), detail);
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Metinden marka kimliği çıkar"
      description="Web sitenizin “Hakkımızda” yazısını, marka kılavuzunuzu ya da birkaç örnek gönderiyi yapıştırın. Boş alanlar doldurulur; elle girdiklerinize dokunulmaz."
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" disabled={busy || (!text.trim() && !entity.assets.length)} onClick={run}>
            {busy ? <Spinner /> : <Sparkles />} Çıkar
          </button>
        </>
      }
    >
      <textarea
        autoFocus
        className="input"
        rows={11}
        placeholder="Markayı anlatan metni buraya yapıştırın…"
        aria-label="Marka metni"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </Dialog>
  );
}

interface SiteSummary {
  logo: boolean;
  colors: number;
  fonts: string[];
  analyzed: boolean;
}

function SiteDialog({ entity, open, onClose }: { entity: EntityDetail; open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setUrl(entity.data.website ?? '');
  }, [open, entity.data.website]);

  const run = async () => {
    setBusy(true);
    const result = await attempt(() => api.post<{ entity: EntityDetail; summary: SiteSummary }>(`/api/entities/${entity.id}/brand-site`, { url }));
    setBusy(false);
    if (!result) return;
    queryClient.setQueryData(keys.entity(entity.id), result.entity);
    void queryClient.invalidateQueries({ queryKey: keys.bootstrap });
    const { summary } = result;
    const found = [
      summary.logo && 'logo',
      summary.colors > 0 && `${summary.colors} renk`,
      summary.fonts.length > 0 && `yazı tipi (${summary.fonts.join(', ')})`,
      summary.analyzed && 'ses tonu ve tanıtım',
    ].filter(Boolean);
    toast(found.length ? `Siteden alındı: ${found.join(', ')}.` : 'Siteden kullanılabilir bir marka bilgisi çıkmadı.', found.length ? 'ok' : 'info');
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Web sitesinden marka kur"
      description="Bellek sitenizin ana sayfasını okur; logoyu, renkleri, yazı tiplerini ve tanıtım metnini çıkarıp marka kitine yerleştirir. Elle girdiğiniz alanlara dokunmaz."
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" disabled={busy || !url.trim()} onClick={run}>
            {busy ? <Spinner /> : <Globe />} {busy ? 'Site okunuyor…' : 'Siteyi oku'}
          </button>
        </>
      }
    >
      <Field label="Site adresi">
        <input
          autoFocus
          className="input"
          inputMode="url"
          placeholder="ornekmarka.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && url.trim() && !busy && void run()}
        />
      </Field>
    </Dialog>
  );
}

export function BrandKit({ entity }: { entity: EntityDetail }) {
  const [data, setData] = useState<EntityData>(entity.data);
  const [extracting, setExtracting] = useState(false);
  const [siteOpen, setSiteOpen] = useState(false);
  const [sampling, setSampling] = useState(false);

  useEffect(() => setData(entity.data), [entity.data]);

  const save = async (patch: EntityData) => {
    setData((current) => ({ ...current, ...patch }));
    const detail = await attempt(() => api.patch<EntityDetail>(`/api/entities/${entity.id}`, { data: patch }));
    if (detail) queryClient.setQueryData(keys.entity(entity.id), detail);
  };

  const colors = data.colors ?? [];
  const setColor = (index: number, patch: Partial<BrandColor>, commit = false) => {
    const next = colors.map((color, i) => (i === index ? { ...color, ...patch } : color));
    if (commit) void save({ colors: next });
    else setData((current) => ({ ...current, colors: next }));
  };

  const fromLogo = async () => {
    const logo = entity.assets.find((a) => a.role === 'logo') ?? entity.assets[0];
    if (!logo) return toast('Önce bir logo ekleyin.');
    setSampling(true);
    try {
      const found = await extractPalette(logo.url);
      if (!found.length) toast('Logodan belirgin bir renk çıkarılamadı.');
      else await save({ colors: found });
    } catch {
      toast('Logo okunamadı.', 'error');
    } finally {
      setSampling(false);
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="flex-1 text-[0.95rem] font-semibold">Renk paleti</h3>
          <button type="button" className="btn btn-ghost btn-sm" disabled={sampling} onClick={fromLogo}>
            {sampling ? <Spinner /> : <Pipette />} Logodan çıkar
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void save({ colors: [...colors, { name: '', hex: '#888888', role: 'accent' }] })}>
            <Plus /> Renk ekle
          </button>
        </div>
        {colors.length ? (
          <>
            <div className="flex h-14 overflow-hidden rounded-xl border border-line">
              {colors.map((color, index) => (
                <div key={index} className="flex-1" style={{ background: color.hex }} title={`${color.name || ROLES.find((r) => r.id === color.role)?.label} ${color.hex}`} />
              ))}
            </div>
            <ul className="mt-2.5 flex flex-col gap-1.5">
              {colors.map((color, index) => (
                <li key={index} className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Renk seç"
                    value={/^#[0-9a-f]{6}$/i.test(color.hex) ? color.hex : '#888888'}
                    onChange={(event) => setColor(index, { hex: event.target.value.toUpperCase() })}
                    onBlur={() => void save({ colors })}
                    className="h-8 w-9 flex-none cursor-pointer rounded-md border border-line bg-transparent p-0.5"
                  />
                  <input
                    className="input !h-8 !w-[6.2rem] flex-none font-mono !text-[0.82rem]"
                    aria-label="Hex kodu"
                    value={color.hex}
                    maxLength={7}
                    onChange={(event) => setColor(index, { hex: event.target.value.toUpperCase() })}
                    onBlur={() => /^#[0-9A-F]{6}$/.test(color.hex) && void save({ colors })}
                  />
                  <input
                    className="input !h-8 min-w-0 flex-1 !text-[0.88rem]"
                    placeholder="Renk adı"
                    aria-label="Renk adı"
                    value={color.name}
                    onChange={(event) => setColor(index, { name: event.target.value })}
                    onBlur={() => void save({ colors })}
                  />
                  <select
                    className="input !h-8 !w-[6.6rem] flex-none !text-[0.86rem]"
                    aria-label="Rol"
                    value={color.role}
                    onChange={(event) => setColor(index, { role: event.target.value as BrandColorRole }, true)}
                  >
                    {ROLES.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                  <IconButton label="Rengi kaldır" size="sm" onClick={() => void save({ colors: colors.filter((_, i) => i !== index) })}>
                    <Trash2 />
                  </IconButton>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-[0.9rem] text-ink-3">
            Palet boş. Logodan otomatik çıkarın ya da renkleri hex koduyla ekleyin; üretimlerde bu kodlar kullanılır.
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="flex-1 text-[0.95rem] font-semibold">Kimlik ve ses</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSiteOpen(true)}>
            <Globe /> Web sitesinden çek
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExtracting(true)}>
            <Sparkles /> Metinden çıkar
          </button>
        </div>
        <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
          {TEXT_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <input
                className="input"
                placeholder={field.placeholder}
                value={data[field.key] ?? ''}
                onChange={(event) => setData((current) => ({ ...current, [field.key]: event.target.value }))}
                onBlur={() => data[field.key] !== entity.data[field.key] && void save({ [field.key]: data[field.key] ?? '' })}
              />
            </Field>
          ))}
          {LONG_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <textarea
                className="input"
                rows={3}
                placeholder={field.placeholder}
                value={data[field.key] ?? ''}
                onChange={(event) => setData((current) => ({ ...current, [field.key]: event.target.value }))}
                onBlur={() => data[field.key] !== entity.data[field.key] && void save({ [field.key]: data[field.key] ?? '' })}
              />
            </Field>
          ))}
          <Field label="Başlık yazı tipi">
            <input
              className="input"
              placeholder="Örn. Poppins"
              value={data.fonts?.heading ?? ''}
              onChange={(event) => setData((current) => ({ ...current, fonts: { ...current.fonts, heading: event.target.value } }))}
              onBlur={() => void save({ fonts: data.fonts })}
            />
          </Field>
          <Field label="Metin yazı tipi">
            <input
              className="input"
              placeholder="Örn. Inter"
              value={data.fonts?.body ?? ''}
              onChange={(event) => setData((current) => ({ ...current, fonts: { ...current.fonts, body: event.target.value } }))}
              onBlur={() => void save({ fonts: data.fonts })}
            />
          </Field>
          <Field label="İmza etiketler" hint="Boşlukla ayırın.">
            <input
              className="input"
              placeholder="#acmekahve #üçüncüdalga"
              value={(data.hashtags ?? []).join(' ')}
              onChange={(event) => setData((current) => ({ ...current, hashtags: event.target.value.split(/\s+/) }))}
              onBlur={() =>
                void save({
                  hashtags: (data.hashtags ?? []).map((t) => t.trim()).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)),
                })
              }
            />
          </Field>
          <Field label="Emoji kullanımı">
            <select className="input" value={data.emoji ?? 'light'} onChange={(event) => void save({ emoji: event.target.value as EntityData['emoji'] })}>
              <option value="none">Hiç</option>
              <option value="light">Ölçülü</option>
              <option value="rich">Serbest</option>
            </select>
          </Field>
        </div>
      </div>
      <ExtractDialog entity={entity} open={extracting} onClose={() => setExtracting(false)} />
      <SiteDialog entity={entity} open={siteOpen} onClose={() => setSiteOpen(false)} />
    </div>
  );
}
