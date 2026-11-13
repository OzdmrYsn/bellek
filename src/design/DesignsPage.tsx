import { LayoutTemplate, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Design } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { timeAgo } from '../lib/format.ts';
import { keys, queryClient, useApp, useDesigns } from '../lib/queries.ts';
import { attempt, toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Empty, Field, PageHeader, PageLoader } from '../ui/kit.tsx';
import { Menu } from '../ui/Popover.tsx';
import { SizePicker, type SizeValue } from '../ui/SizePicker.tsx';
import { prepare, renderDesign, type ImageStore } from './render.ts';

const sharedStore: ImageStore = new Map();

/** Tasarımı küçük bir tuvale çizer; önizleme için ayrıca dosya saklanmaz. */
function DesignPreview({ design }: { design: Design }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const scale = 420 / Math.max(design.width, design.height);
    void prepare(design.doc, sharedStore).then(() => {
      if (!cancelled && canvas.current) renderDesign(canvas.current, design.doc, design.width, design.height, sharedStore, scale);
    });
    return () => {
      cancelled = true;
    };
  }, [design]);
  return <canvas ref={canvas} className="max-h-full max-w-full rounded-[3px] shadow-[0_4px_18px_oklch(0_0_0/0.35)]" style={{ aspectRatio: `${design.width} / ${design.height}` }} />;
}

function NewDesignDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const navigate = useNavigate();
  const brands = app.entities.filter((e) => e.type === 'brand');
  const [size, setSize] = useState<SizeValue>({ aspect: '4:5', width: 1080, height: 1350 });
  const [brandId, setBrandId] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setBrandId(brands[0]?.id ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = async () => {
    const design = await attempt(() =>
      api.post<Design>('/api/designs', {
        name: name.trim() || 'Adsız tasarım', width: size.width, height: size.height, brandId: brandId || null,
        doc: { background: '#FFFFFF', layers: [] },
      }),
    );
    if (!design) return;
    void queryClient.invalidateQueries({ queryKey: keys.designs });
    onClose();
    navigate(`/tasarim/${design.id}`);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Yeni tasarım"
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" onClick={create}>Oluştur</button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Ad">
          <input autoFocus className="input" placeholder="Örn. Yeni sezon duyurusu" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void create()} />
        </Field>
        <SizePicker value={size} onChange={setSize} pixelsOnly customHint="Tuval tam bu ölçüde açılır." />
        {brands.length > 0 && (
          <Field label="Marka" hint="Seçilen markanın renkleri, yazı tipleri ve logosu editörde hazır olur.">
            <select className="input" value={brandId} onChange={(event) => setBrandId(event.target.value)}>
              <option value="">Marka yok</option>
              {brands.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export default function DesignsPage() {
  const designs = useDesigns();
  const [creating, setCreating] = useState(false);
  const items = designs.data ?? [];

  const remove = async (design: Design) => {
    await attempt(() => api.del(`/api/designs/${design.id}`));
    void queryClient.invalidateQueries({ queryKey: keys.designs });
    toast('Tasarım çöp kutusuna taşındı.', 'info', {
      label: 'Geri al',
      run: () => void api.post('/api/trash/restore', { kind: 'design', id: design.id }).then(() => queryClient.invalidateQueries({ queryKey: keys.designs })),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Tasarım"
        subtitle="Üretilen görsellerin üzerine gerçek logonuzu, tam renk kodlarınızı ve hatasız metni yerleştirin."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus /> Yeni tasarım
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 max-md:px-4">
        {designs.isLoading ? (
          <PageLoader />
        ) : !items.length ? (
          <Empty
            icon={<LayoutTemplate />}
            title="Henüz tasarım yok"
            body="Yapay zekâ görselde yazıyı ve logoyu her zaman tutturamaz. Burada görseli zemine alır, başlığı ve logoyu kendiniz, piksel hassasiyetiyle yerleştirirsiniz."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus /> İlk tasarımı oluştur
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
            {items.map((design) => (
              <div key={design.id} className="group relative">
                <Link to={`/tasarim/${design.id}`} className="block overflow-hidden rounded-[14px] border border-line bg-surface transition-colors hover:border-line-strong">
                  <div className="grid aspect-[4/3] place-items-center bg-stage p-4">
                    <DesignPreview design={design} />
                  </div>
                  <div className="px-3.5 py-3">
                    <div className="truncate text-[0.95rem] font-semibold">{design.name}</div>
                    <div className="mt-0.5 text-[0.8rem] text-ink-3">
                      <span className="font-mono text-[0.74rem]">{design.width}×{design.height}</span> · {timeAgo(design.updatedAt)}
                    </div>
                  </div>
                </Link>
                <div className="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <Menu
                    trigger={(props) => (
                      <button type="button" {...props} aria-label="Tasarım seçenekleri" className="grid h-7 w-7 place-items-center rounded-md bg-black/60 text-white hover:bg-black/80">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    )}
                    items={[{ label: 'Çöp kutusuna taşı', icon: <Trash2 />, danger: true, onSelect: () => void remove(design) }]}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <NewDesignDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
