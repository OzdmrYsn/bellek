import { Megaphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { PLATFORMS } from '../../shared/platforms.ts';
import type { Campaign, PlatformId, Post } from '../../shared/types.ts';
import { TEMPLATES } from '../design/templates.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { keys, queryClient, useApp } from '../lib/queries.ts';
import { attempt } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Field, Notice, Spinner, Switch } from '../ui/kit.tsx';

/** Düzenin iskeletini gösteren küçük şema; gerçek görsel yerine yerleşimi anlatır. */
function LayoutGlyph({ id }: { id: string }) {
  const bar = 'absolute rounded-[1px] bg-current';
  return (
    <span aria-hidden className="relative block h-11 w-9 flex-none overflow-hidden rounded-[4px] border-[1.5px] border-current">
      {id === 'none' && <span className="absolute inset-0 bg-current opacity-25" />}
      {id === 'bottom' && (
        <>
          <span className="absolute inset-0 bg-current opacity-25" />
          <span className={cx(bar, 'right-1.5 bottom-3 left-1.5 h-1')} />
          <span className={cx(bar, 'bottom-1.5 left-1.5 h-0.5 w-3.5 opacity-70')} />
        </>
      )}
      {id === 'split' && (
        <>
          <span className="absolute inset-x-0 top-0 h-[58%] bg-current opacity-25" />
          <span className={cx(bar, 'right-1.5 bottom-3 left-1.5 h-1')} />
          <span className={cx(bar, 'bottom-1.5 left-1.5 h-0.5 w-3.5 opacity-70')} />
        </>
      )}
      {id === 'quote' && (
        <>
          <span className="absolute inset-0 bg-current opacity-25" />
          <span className={cx(bar, 'top-[42%] right-2 left-2 h-1')} />
          <span className={cx(bar, 'top-[58%] right-3 left-3 h-0.5 opacity-70')} />
        </>
      )}
      {id === 'label' && (
        <>
          <span className="absolute inset-0 bg-current opacity-25" />
          <span className={cx(bar, 'bottom-1.5 left-1.5 h-2 w-5 !rounded-[2px]')} />
        </>
      )}
      {id === 'frame' && (
        <>
          <span className="absolute inset-x-1 top-1 h-[55%] rounded-[2px] bg-current opacity-25" />
          <span className={cx(bar, 'right-1 bottom-3 left-1 h-1')} />
          <span className={cx(bar, 'bottom-1.5 left-1 h-0.5 w-3.5 opacity-70')} />
        </>
      )}
    </span>
  );
}

const LAYOUTS = [{ id: 'none', label: 'Düzen yok', hint: 'Görsel olduğu gibi kullanılır' }, ...TEMPLATES.map(({ id, label, hint }) => ({ id, label, hint }))];

/** Tek briften her platforma uyarlanmış bir gönderi paketi çıkarır. */
export function CampaignDialog({ open, onClose, brandId }: { open: boolean; onClose: () => void; brandId?: string | null }) {
  const app = useApp();
  const navigate = useNavigate();
  const brands = app.entities.filter((e) => e.type === 'brand');
  const hasText = app.models.some((m) => m.model.kind === 'text');
  const hasImage = app.models.some((m) => m.model.kind === 'image');
  const [brand, setBrand] = useState('');
  const [platforms, setPlatforms] = useState<PlatformId[]>(['instagram', 'linkedin', 'x']);
  const [brief, setBrief] = useState('');
  const [date, setDate] = useState('');
  const [images, setImages] = useState(true);
  const [layout, setLayout] = useState('bottom');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBrand(brandId ?? brands[0]?.id ?? '');
    setBrief('');
    setDate('');
    setBusy(false);
    // Yalnızca açılışta sıfırlanır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const withImages = images && hasImage;

  const submit = async () => {
    setBusy(true);
    const result = await attempt(() =>
      api.post<{ campaign: Campaign; posts: Post[] }>('/api/campaigns', {
        brandId: brand || null,
        brief,
        platforms,
        generateImages: withImages,
        template: withImages && layout !== 'none' ? layout : '',
        date: date || null,
      }),
    );
    setBusy(false);
    if (!result) return;
    void queryClient.invalidateQueries({ queryKey: ['posts'] });
    void queryClient.invalidateQueries({ queryKey: keys.campaigns });
    onClose();
    navigate(`/icerik?kampanya=${result.campaign.id}`);
  };

  const toggle = (id: PlatformId) =>
    setPlatforms((current) => (current.includes(id) ? (current.length > 1 ? current.filter((p) => p !== id) : current) : [...current, id]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Kampanya paketi"
      description="Tek bir brif yazın; Bellek her platform için o platformun diline, uzunluğuna ve görsel ölçüsüne uygun ayrı bir gönderi hazırlar."
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-accent" disabled={busy || !hasText || !brief.trim()} onClick={submit}>
            {busy ? <Spinner /> : <Megaphone />} {busy ? 'Paket yazılıyor…' : `${platforms.length} gönderi hazırla`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!hasText && <Notice level="warn">Paketi yazmak için bağlı bir metin modeli gerekiyor. Ayarlar → Yapay zekâlar bölümünden ekleyin.</Notice>}

        <Field label="Brif">
          <textarea
            autoFocus
            className="input"
            rows={4}
            placeholder="Örn. 1 Aralık'ta yeni kış harmanımız çıkıyor: tarçın ve portakal kabuğu notaları, sınırlı üretim. İlk hafta kargo bizden."
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
        </Field>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Marka">
            <select className="input" value={brand} onChange={(event) => setBrand(event.target.value)}>
              <option value="">Marka yok</option>
              {brands.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Yayın günü" hint="Boş bırakırsanız taslak olarak kalır.">
            <input type="date" className="input" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
        </div>

        <div>
          <span className="label">Platformlar</span>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((platform) => (
              <button key={platform.id} type="button" className="chip !h-8 !px-3 !text-[0.86rem]" data-active={platforms.includes(platform.id)} aria-pressed={platforms.includes(platform.id)} onClick={() => toggle(platform.id)}>
                {platform.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-[0.93rem] font-medium">Görselleri de üret</span>
            <span className="hint">
              {hasImage ? 'Her gönderi için platformun tam ölçüsünde bir görsel üretilir.' : 'Bağlı bir görsel modeli yok; yalnızca metinler yazılır.'}
            </span>
          </span>
          <Switch checked={withImages} label="Görselleri de üret" disabled={!hasImage} onChange={setImages} />
        </label>

        {withImages && (
          <div>
            <span className="label">Tasarım düzeni</span>
            <div role="radiogroup" aria-label="Tasarım düzeni" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {LAYOUTS.map((item) => {
                const active = layout === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={item.hint}
                    onClick={() => setLayout(item.id)}
                    className={cx(
                      'flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors',
                      active ? 'border-ink bg-sunken text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink',
                    )}
                  >
                    <LayoutGlyph id={item.id} />
                    <span className="min-w-0 text-[0.86rem] leading-tight font-medium">{item.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="hint mt-2">
              {layout === 'none'
                ? 'Yapay zekâ görselde yazıyı ve logoyu her zaman tutturamaz; düzen seçerseniz bunları Bellek kendisi yerleştirir.'
                : 'Görseller hazır olunca başlık, gerçek logonuz ve marka renkleriniz üzerine yerleştirilir. Her birini sonradan editörde düzeltebilirsiniz.'}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
