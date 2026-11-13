import { Brush, Eraser, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset, Job } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { useModels } from '../lib/queries.ts';
import { toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Segmented, Spinner } from '../ui/kit.tsx';

interface Stroke {
  erase: boolean;
  /** Maske pikseli cinsinden fırça çapı. */
  size: number;
  points: [number, number][];
}

/** Maske, uzun kenarı bu kadar olacak biçimde tutulur; sunucu görselin ölçüsüne getirir. */
const MASK_EDGE = 1280;
const INK = '#ff5a1f';

function paint(ctx: CanvasRenderingContext2D, stroke: Stroke, from = 0): void {
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const points = stroke.points;
  if (points.length === 1 || from === 0) {
    const [x, y] = points[0];
    ctx.beginPath();
    ctx.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  if (points.length < 2) return;
  ctx.beginPath();
  const start = Math.max(0, from - 1);
  ctx.moveTo(points[start][0], points[start][1]);
  for (let i = start + 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
}

/**
 * Bölge düzenleme: değişmesini istediğiniz yeri fırçayla boyayın, ne olacağını
 * yazın. Sonuç yeni bir görsel olarak kaydedilir; boyanmayan pikseller özgün kalır.
 */
export function MaskEditor({ asset, open, onClose, onStarted }: { asset: Asset | null; open: boolean; onClose: () => void; onStarted: (job: Job) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLSpanElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const active = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush');
  const [brush, setBrush] = useState(9);
  // Çizgiler yeniden çizimi tetiklemesin diye ref'te durur; bu sayaç yalnızca düğmeleri günceller.
  const [, bump] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [modelRef, setModelRef] = useState('');
  const [busy, setBusy] = useState(false);
  const models = useModels('image').filter((m) => (m.model.maxRefs ?? 0) >= 1);

  const ratio = asset?.width && asset.height ? asset.width / asset.height : 1;
  const maskWidth = Math.round(ratio >= 1 ? MASK_EDGE : MASK_EDGE * ratio);
  const maskHeight = Math.round(ratio >= 1 ? MASK_EDGE / ratio : MASK_EDGE);
  /** Fırça çapı, kısa kenarın yüzdesi olarak seçilir. */
  const brushPx = (Math.min(maskWidth, maskHeight) * brush) / 100;

  useEffect(() => {
    if (!open) return;
    strokes.current = [];
    active.current = null;
    bump((n) => n + 1);
    setPrompt('');
    setTool('brush');
    setBusy(false);
    canvas.current?.getContext('2d')?.clearRect(0, 0, maskWidth, maskHeight);
  }, [open, asset?.id, maskWidth, maskHeight]);

  const redraw = useCallback(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, maskWidth, maskHeight);
    for (const stroke of strokes.current) paint(ctx, stroke);
    bump((n) => n + 1);
  }, [maskWidth, maskHeight]);

  const toMask = (event: React.PointerEvent): [number, number] => {
    const box = canvas.current!.getBoundingClientRect();
    return [((event.clientX - box.left) / box.width) * maskWidth, ((event.clientY - box.top) / box.height) * maskHeight];
  };

  const moveCursor = (event: React.PointerEvent) => {
    const node = cursor.current;
    const box = canvas.current?.getBoundingClientRect();
    if (!node || !box) return;
    const size = (brushPx / maskWidth) * box.width;
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
    node.style.transform = `translate(${event.clientX - box.left - size / 2}px, ${event.clientY - box.top - size / 2}px)`;
    node.style.opacity = '1';
  };

  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: Stroke = { erase: tool === 'eraser', size: brushPx, points: [toMask(event)] };
    active.current = stroke;
    strokes.current.push(stroke);
    const ctx = canvas.current?.getContext('2d');
    if (ctx) paint(ctx, stroke);
  };

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    moveCursor(event);
    const stroke = active.current;
    if (!stroke) return;
    const from = stroke.points.length;
    stroke.points.push(toMask(event));
    const ctx = canvas.current?.getContext('2d');
    if (ctx) paint(ctx, stroke, from);
  };

  const onUp = () => {
    if (!active.current) return;
    active.current = null;
    bump((n) => n + 1);
  };

  const undo = useCallback(() => {
    strokes.current.pop();
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, undo]);

  /** Görünen boyamayı siyah zemin üzerinde beyaza çevirir: beyaz = değişecek alan. */
  const exportMask = (): string => {
    const tinted = document.createElement('canvas');
    tinted.width = maskWidth;
    tinted.height = maskHeight;
    const t = tinted.getContext('2d')!;
    t.drawImage(canvas.current!, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = '#ffffff';
    t.fillRect(0, 0, maskWidth, maskHeight);
    const out = document.createElement('canvas');
    out.width = maskWidth;
    out.height = maskHeight;
    const o = out.getContext('2d')!;
    o.fillStyle = '#000000';
    o.fillRect(0, 0, maskWidth, maskHeight);
    o.drawImage(tinted, 0, 0);
    return out.toDataURL('image/png');
  };

  const submit = async () => {
    if (!asset || busy) return;
    setBusy(true);
    try {
      const job = await api.post<Job>(`/api/assets/${asset.id}/tools`, {
        op: 'inpaint',
        prompt: prompt.trim(),
        mask: exportMask(),
        modelRef: modelRef || null,
      });
      onStarted(job);
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Düzenleme başlatılamadı.', 'error');
      setBusy(false);
    }
  };

  const ready = strokes.current.some((stroke) => !stroke.erase) && prompt.trim().length > 0 && !busy;

  return (
    <Dialog open={open && !!asset} onClose={onClose} bare className="w-[min(64rem,calc(100vw-2rem))]">
      {asset && (
        <div className="flex max-h-[min(92dvh,56rem)] flex-col">
          <header className="flex items-start gap-4 px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[1.08rem] font-semibold">Bölge düzenle</h2>
              <p className="mt-0.5 text-[0.9rem] text-ink-2">Değişmesini istediğiniz yeri boyayın. Boyamadığınız her piksel olduğu gibi kalır.</p>
            </div>
            <button type="button" className="btn btn-ghost btn-icon btn-sm -mr-1.5" onClick={onClose} aria-label="Kapat">
              <X />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 items-center justify-center bg-stage px-4 py-4">
            <div
              className="relative max-h-full max-w-full touch-none overflow-hidden rounded-lg select-none"
              style={{ aspectRatio: `${maskWidth} / ${maskHeight}`, height: `min(58dvh, calc((100vw - 4rem) / ${ratio}))` }}
            >
              <img src={asset.url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-fill" />
              <canvas
                ref={canvas}
                width={maskWidth}
                height={maskHeight}
                aria-label="Düzenlenecek alanı boyama yüzeyi"
                className="absolute inset-0 h-full w-full cursor-none opacity-55"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={() => {
                  if (cursor.current) cursor.current.style.opacity = '0';
                }}
              />
              <span
                ref={cursor}
                aria-hidden
                className="pointer-events-none absolute top-0 left-0 rounded-full border-[1.5px] border-white opacity-0 shadow-[0_0_0_1px_rgb(0_0_0/0.55)]"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-5 py-2.5">
            <Segmented
              size="sm"
              value={tool}
              onChange={setTool}
              options={[
                { value: 'brush', label: 'Fırça', icon: <Brush /> },
                { value: 'eraser', label: 'Silgi', icon: <Eraser /> },
              ]}
            />
            <label className="flex items-center gap-2.5 text-[0.86rem] text-ink-2">
              Kalınlık
              <input
                type="range"
                min={2}
                max={30}
                value={brush}
                onChange={(event) => setBrush(Number(event.target.value))}
                className="w-32 accent-[var(--ink)]"
              />
            </label>
            <span className="flex-1" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={undo} disabled={!strokes.current.length} title="Geri al (⌘Z)">
              <Undo2 /> Geri al
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!strokes.current.length}
              onClick={() => {
                strokes.current = [];
                redraw();
              }}
            >
              Temizle
            </button>
          </div>

          <form
            className="flex flex-wrap items-end gap-3 px-5 py-3.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="min-w-[16rem] flex-1">
              <span className="label">Bu alanda ne olsun?</span>
              <input
                className="input"
                autoFocus
                placeholder="ör. masadaki bardağı kaldır, yerine bir saksı koy"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            {models.length > 1 && (
              <label className="w-52">
                <span className="label">Model</span>
                <select className="input" value={modelRef} onChange={(event) => setModelRef(event.target.value)}>
                  <option value="">Otomatik</option>
                  {models.map((model) => (
                    <option key={model.ref} value={model.ref}>
                      {model.model.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit" className="btn btn-accent" disabled={!ready}>
              {busy && <Spinner />}
              Düzenle
            </button>
          </form>
        </div>
      )}
    </Dialog>
  );
}
