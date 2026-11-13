import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PLATFORMS } from '../../shared/platforms.ts';
import type { PlatformId, Post } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { dayKey } from '../lib/format.ts';
import { queryClient, useApp } from '../lib/queries.ts';
import { attempt, toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Field, Notice, Spinner, Switch } from '../ui/kit.tsx';

interface PlanDialogProps {
  open: boolean;
  onClose: () => void;
  from?: string;
  to?: string;
  brandId?: string | null;
}

function nextWeek(): { from: string; to: string } {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { from: dayKey(start), to: dayKey(end) };
}

/** Bir tarih aralığı için içerik planını yapay zekâya yazdırır ve takvime kaydeder. */
export function PlanDialog({ open, onClose, from, to, brandId }: PlanDialogProps) {
  const app = useApp();
  const brands = app.entities.filter((e) => e.type === 'brand');
  const hasText = app.models.some((m) => m.model.kind === 'text');
  const hasImage = app.models.some((m) => m.model.kind === 'image');
  const [brand, setBrand] = useState('');
  const [range, setRange] = useState(nextWeek);
  const [count, setCount] = useState(5);
  const [platforms, setPlatforms] = useState<PlatformId[]>(['instagram']);
  const [brief, setBrief] = useState('');
  const [images, setImages] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBrand(brandId ?? brands[0]?.id ?? '');
    setRange(from && to ? { from, to } : nextWeek());
    setBrief('');
    setImages(false);
    // Yalnızca açılışta sıfırlanır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    setBusy(true);
    const posts = await attempt(() =>
      api.post<Post[]>('/api/posts/plan', { brandId: brand || null, ...range, count, platforms, brief, generateImages: images }),
    );
    setBusy(false);
    if (!posts) return;
    void queryClient.invalidateQueries({ queryKey: ['posts'] });
    toast(`${posts.length} gönderi takvime eklendi.`, 'ok');
    onClose();
  };

  const toggle = (id: PlatformId) =>
    setPlatforms((current) => (current.includes(id) ? (current.length > 1 ? current.filter((p) => p !== id) : current) : [...current, id]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Yapay zekâyla içerik planla"
      description="Bellek, markanızın kimliğini ve hafızadaki notları kullanarak tarihli gönderi taslakları yazar. Hepsi takvime düşer; istediğinizi düzenlersiniz."
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-accent" disabled={busy || !hasText || range.from > range.to} onClick={submit}>
            {busy ? <Spinner /> : <Sparkles />} {busy ? 'Plan yazılıyor…' : 'Planı oluştur'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!hasText && <Notice level="warn">Plan yazmak için bağlı bir metin modeli gerekiyor. Ayarlar → Yapay zekâlar bölümünden ekleyin.</Notice>}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Marka">
            <select className="input" value={brand} onChange={(event) => setBrand(event.target.value)}>
              <option value="">Marka yok</option>
              {brands.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Gönderi sayısı">
            <input type="number" min={1} max={31} className="input" value={count} onChange={(event) => setCount(Math.min(31, Math.max(1, Number(event.target.value) || 1)))} />
          </Field>
          <Field label="Başlangıç">
            <input type="date" className="input" value={range.from} onChange={(event) => setRange((r) => ({ ...r, from: event.target.value }))} />
          </Field>
          <Field label="Bitiş" error={range.from > range.to ? 'Bitiş, başlangıçtan önce olamaz.' : null}>
            <input type="date" className="input" value={range.to} min={range.from} onChange={(event) => setRange((r) => ({ ...r, to: event.target.value }))} />
          </Field>
        </div>

        <div>
          <span className="label">Platformlar</span>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((platform) => (
              <button key={platform.id} type="button" className="chip !h-8 !px-3 !text-[0.86rem]" data-active={platforms.includes(platform.id)} onClick={() => toggle(platform.id)}>
                {platform.label}
              </button>
            ))}
          </div>
        </div>

        <Field label="Brif" hint="Boş bırakırsanız markaya uygun dengeli bir karışım önerilir.">
          <textarea
            className="input"
            rows={4}
            placeholder="Örn. Yeni sezon çekirdeklerimizi tanıtıyoruz. Bir gönderi demleme ipucu, biri üretici hikâyesi olsun. Cuma günü açılış kampanyası var."
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
        </Field>

        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-[0.93rem] font-medium">Görselleri de şimdi üret</span>
            <span className="hint">Kapalıyken yalnızca metinler ve görsel istemleri yazılır; görselleri sonra tek tek ya da topluca üretirsiniz.</span>
          </span>
          <Switch checked={images && hasImage} label="Görselleri de şimdi üret" disabled={!hasImage} onChange={setImages} />
        </label>
      </div>
    </Dialog>
  );
}
