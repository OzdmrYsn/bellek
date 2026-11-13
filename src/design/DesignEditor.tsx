import {
  ArrowLeft, Check, Download, Image as ImageIcon, LayoutTemplate, Newspaper, Redo2, Save, Sparkles, Square, Stamp, Type,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ASPECTS, SIZE_PRESETS, nearestAspect, ratioOf } from '../../shared/platforms.ts';
import type { Design, DesignDoc, ImageLayer, Job, Layer, Post, TextLayer } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { keys, queryClient, useApp, useDesign, useEntity, useJob } from '../lib/queries.ts';
import { attempt, pickAssets, toast } from '../lib/store.ts';
import { uploadFiles } from '../library/upload.ts';
import { Empty, IconButton, PageLoader, Spinner } from '../ui/kit.tsx';
import { Popover } from '../ui/Popover.tsx';
import { SizePicker } from '../ui/SizePicker.tsx';
import { ArrangePanel, ColorField, ImagePanel, LayerList, PanelSection, Row, ShapePanel, TextPanel, brandSwatches } from './panels.tsx';
import { exportDesign, hitLayer, loadImage, newId, prepare, renderDesign, textHeight, type ImageStore } from './render.ts';
import { TEMPLATES, applyTemplate, logoLayer, shapeLayer, textLayer } from './templates.ts';

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'e' | 'w';

interface DragState {
  mode: 'move' | Handle;
  startX: number;
  startY: number;
  origin: Layer;
  before: DesignDoc;
  moved: boolean;
}

const HANDLE_POS: Record<Handle, { left: string; top: string; cursor: string }> = {
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  w: { left: '0%', top: '50%', cursor: 'ew-resize' },
};

function fitText<T extends Layer>(layer: T): T {
  return layer.type === 'text' ? { ...layer, h: textHeight(layer as TextLayer) } : layer;
}

function BackgroundJob({ jobId, onDone }: { jobId: string; onDone: (job: Job) => void }) {
  const job = useJob(jobId);
  useEffect(() => {
    if (job && ['succeeded', 'failed', 'canceled'].includes(job.status)) onDone(job);
  }, [job, onDone]);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-2 text-[0.8rem] text-accent-text">
      <Spinner className="!h-3.5 !w-3.5" /> {job?.stage ?? 'Üretiliyor'}
    </div>
  );
}

export default function DesignEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const app = useApp();
  const query = useDesign(id);
  const design = query.data;

  const [doc, setDoc] = useState<DesignDoc>({ background: '#ffffff', layers: [] });
  const [size, setSize] = useState({ width: 1080, height: 1350 });
  const [name, setName] = useState('');
  const [brandId, setBrandId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scale, setScale] = useState(0.4);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [exporting, setExporting] = useState<string | null>(null);
  const [headline, setHeadline] = useState('Başlığınızı buraya yazın');
  const [subline, setSubline] = useState('Kısa bir açıklama ya da çağrı');
  const [bgPrompt, setBgPrompt] = useState('');
  const [bgJob, setBgJob] = useState<string | null>(null);

  const past = useRef<DesignDoc[]>([]);
  const future = useRef<DesignDoc[]>([]);
  const [, bump] = useState(0);
  const store = useRef<ImageStore>(new Map());
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const loaded = useRef<string | null>(null);
  const saveTimer = useRef(0);
  const docRef = useRef(doc);
  docRef.current = doc;

  const brandQuery = useEntity(brandId ?? undefined);
  const brand = brandQuery.data ?? null;
  const logoAssetId = brand?.assets.find((a) => a.role === 'logo')?.id ?? null;
  const brands = app.entities.filter((e) => e.type === 'brand');
  const selected = doc.layers.find((layer) => layer.id === selectedId) ?? null;

  // İlk yükleme: sunucudaki belge yerel duruma alınır.
  useEffect(() => {
    if (!design || loaded.current === design.id) return;
    loaded.current = design.id;
    setDoc(design.doc);
    setSize({ width: design.width, height: design.height });
    setName(design.name);
    setBrandId(design.brandId);
    past.current = [];
    future.current = [];
    setSelectedId(null);
  }, [design]);

  // Tuvali sahneye sığdır.
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const fit = () => {
      const pad = 72;
      setScale(Math.max(0.05, Math.min((node.clientWidth - pad) / size.width, (node.clientHeight - pad) / size.height, 1)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [size.width, size.height, !!design]);

  // Çizim: gereken görseller ve yazı tipleri hazır olunca tuvale basılır.
  useEffect(() => {
    let cancelled = false;
    const draw = () => {
      if (!cancelled && canvas.current) renderDesign(canvas.current, doc, size.width, size.height, store.current, scale * Math.min(2, window.devicePixelRatio || 1));
    };
    draw();
    void prepare(doc, store.current).then(draw);
    return () => {
      cancelled = true;
    };
  }, [doc, size, scale]);

  // Otomatik kayıt.
  useEffect(() => {
    if (!design || loaded.current !== design.id) return;
    if (doc === design.doc && name === design.name && size.width === design.width && size.height === design.height && brandId === design.brandId) return;
    setSaveState('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const next = await attempt(() => api.patch<Design>(`/api/designs/${design.id}`, { doc, name, ...size, brandId }));
      if (next) {
        queryClient.setQueryData(keys.design(design.id), { ...next, doc });
        void queryClient.invalidateQueries({ queryKey: keys.designs });
      }
      setSaveState(next ? 'saved' : 'idle');
    }, 800);
    return () => window.clearTimeout(saveTimer.current);
  }, [doc, name, size, brandId, design]);

  const commit = useCallback((before: DesignDoc) => {
    past.current = [...past.current.slice(-80), before];
    future.current = [];
    bump((n) => n + 1);
  }, []);

  const change = useCallback(
    (next: DesignDoc) => {
      commit(docRef.current);
      setDoc(next);
    },
    [commit],
  );

  // Kaydırıcı gibi art arda gelen küçük değişiklikler tek bir geri alma adımı sayılır.
  const lastPatch = useRef({ key: '', at: 0 });
  const patchLayer = useCallback(
    (layerId: string, patch: Partial<Layer>) => {
      const key = `${layerId}:${Object.keys(patch).join(',')}`;
      const now = Date.now();
      const sameBurst = lastPatch.current.key === key && now - lastPatch.current.at < 900;
      lastPatch.current = { key, at: now };
      const next: DesignDoc = {
        ...docRef.current,
        layers: docRef.current.layers.map((layer) => (layer.id === layerId ? fitText({ ...layer, ...patch } as Layer) : layer)),
      };
      if (sameBurst) setDoc(next);
      else change(next);
    },
    [change],
  );

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(docRef.current);
    setDoc(previous);
    bump((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(docRef.current);
    setDoc(next);
    bump((n) => n + 1);
  }, []);

  const addLayer = useCallback(
    (layer: Layer, atBottom = false) => {
      const layers = atBottom ? [layer, ...docRef.current.layers] : [...docRef.current.layers, layer];
      change({ ...docRef.current, layers });
      setSelectedId(layer.id);
    },
    [change],
  );

  const removeLayer = useCallback(
    (layerId: string) => {
      change({ ...docRef.current, layers: docRef.current.layers.filter((layer) => layer.id !== layerId) });
      setSelectedId(null);
    },
    [change],
  );

  const duplicate = useCallback(
    (layerId: string) => {
      const source = docRef.current.layers.find((layer) => layer.id === layerId);
      if (source) addLayer({ ...source, id: newId(), x: source.x + 30, y: source.y + 30 });
    },
    [addLayer],
  );

  const reorder = useCallback(
    (layerId: string, step: number) => {
      const layers = [...docRef.current.layers];
      const index = layers.findIndex((layer) => layer.id === layerId);
      const target = Math.min(layers.length - 1, Math.max(0, index + step));
      if (index < 0 || target === index) return;
      layers.splice(target, 0, ...layers.splice(index, 1));
      change({ ...docRef.current, layers });
    },
    [change],
  );

  // Klavye kısayolları.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (document.querySelector('dialog[open]')) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        return event.shiftKey ? redo() : undo();
      }
      if (!selectedId) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeLayer(selectedId);
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicate(selectedId);
      } else if (event.key === 'Escape') {
        setSelectedId(null);
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const layer = docRef.current.layers.find((l) => l.id === selectedId);
        if (!layer) return;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        patchLayer(selectedId, { x: layer.x + dx, y: layer.y + dy });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, undo, redo, removeLayer, duplicate, patchLayer]);

  // ── Tuval üzerinde seçme, taşıma, boyutlandırma ──

  const toDoc = (event: React.PointerEvent): { x: number; y: number } => {
    const box = canvas.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
  };

  const onPointerDown = (event: React.PointerEvent, handle?: Handle) => {
    if (event.button !== 0) return;
    const p = toDoc(event);
    let target = handle && selected ? selected : null;
    if (!target) {
      target = [...doc.layers].reverse().find((layer) => !layer.hidden && !layer.locked && hitLayer(layer, p.x, p.y)) ?? null;
    }
    setSelectedId(target?.id ?? null);
    if (!target) return;
    event.preventDefault();
    // Yakalama her zaman kaplama katmanındadır; tutamaçtan başlasa da sürükleme orada izlenir.
    overlay.current?.setPointerCapture(event.pointerId);
    drag.current = { mode: handle ?? 'move', startX: p.x, startY: p.y, origin: target, before: doc, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const p = toDoc(event);
    const dx = p.x - state.startX;
    const dy = p.y - state.startY;
    if (!state.moved && Math.hypot(dx, dy) * scale < 3) return;
    state.moved = true;
    const o = state.origin;
    let next: Layer;

    if (state.mode === 'move') {
      let x = o.x + dx;
      let y = o.y + dy;
      // Kenarlara ve merkeze yapış.
      const tolerance = 7 / scale;
      let guideX: number | null = null;
      let guideY: number | null = null;
      for (const [edge, line] of [[x, 0], [x + o.w / 2, size.width / 2], [x + o.w, size.width]] as const) {
        if (Math.abs(edge - line) < tolerance) {
          x += line - edge;
          guideX = line;
          break;
        }
      }
      for (const [edge, line] of [[y, 0], [y + o.h / 2, size.height / 2], [y + o.h, size.height]] as const) {
        if (Math.abs(edge - line) < tolerance) {
          y += line - edge;
          guideY = line;
          break;
        }
      }
      setGuides({ x: guideX, y: guideY });
      next = { ...o, x: Math.round(x), y: Math.round(y) };
    } else if (state.mode === 'e' || state.mode === 'w') {
      const w = Math.max(40, state.mode === 'e' ? o.w + dx : o.w - dx);
      next = fitText({ ...o, w: Math.round(w), x: Math.round(state.mode === 'e' ? o.x : o.x + o.w - w) });
    } else {
      const right = state.mode.endsWith('e');
      const bottom = state.mode.startsWith('s');
      let w = Math.max(24, right ? o.w + dx : o.w - dx);
      let h = Math.max(24, bottom ? o.h + dy : o.h - dy);
      if (o.type === 'text') {
        // Köşeden çekmek metni ölçekler; sarma genişliği kenar tutamaçlarıyla ayarlanır.
        const ratio = w / o.w;
        const scaled = fitText({ ...o, w: Math.round(w), size: Math.max(6, Math.round(o.size * ratio)), padding: Math.round(o.padding * ratio), radius: Math.round(o.radius * ratio) });
        next = { ...scaled, x: Math.round(right ? o.x : o.x + o.w - w), y: Math.round(bottom ? o.y : o.y + o.h - scaled.h) };
      } else {
        if (event.shiftKey || (o.type === 'image' && o.fit === 'contain')) {
          const ratio = o.w / o.h;
          if (w / h > ratio) h = w / ratio;
          else w = h * ratio;
        }
        next = { ...o, w: Math.round(w), h: Math.round(h), x: Math.round(right ? o.x : o.x + o.w - w), y: Math.round(bottom ? o.y : o.y + o.h - h) };
      }
    }
    setDoc({ ...state.before, layers: state.before.layers.map((layer) => (layer.id === o.id ? next : layer)) });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const state = drag.current;
    drag.current = null;
    setGuides({ x: null, y: null });
    if (overlay.current?.hasPointerCapture(event.pointerId)) overlay.current.releasePointerCapture(event.pointerId);
    if (state?.moved) commit(state.before);
  };

  // ── Ekleme eylemleri ──

  const addImage = async () => {
    const [assetId] = await pickAssets({ title: 'Tasarıma görsel ekle', multiple: false, kind: 'image' });
    if (!assetId) return;
    const image = await loadImage(assetId, store.current);
    const ratio = image ? image.naturalWidth / image.naturalHeight : 1;
    const empty = !doc.layers.some((layer) => layer.type === 'image');
    const w = empty ? size.width : Math.round(size.width * 0.6);
    const h = empty ? size.height : Math.round(w / ratio);
    const layer: ImageLayer = {
      id: newId(), type: 'image', assetId, x: Math.round((size.width - w) / 2), y: Math.round((size.height - h) / 2), w, h,
      rotation: 0, opacity: 1, fit: 'cover', focusX: 0.5, focusY: 0.5, radius: 0,
    };
    addLayer(layer, empty);
  };

  const addText = () => {
    const m = Math.round(size.width * 0.08);
    const layer = textLayer({
      text: 'Yeni metin', x: m, y: Math.round(size.height * 0.4), w: size.width - m * 2, size: Math.round(size.width * 0.07),
      font: brand?.data.fonts?.heading?.trim() || 'Instrument Sans Variable',
      color: doc.layers.length ? '#FFFFFF' : '#111111',
    });
    addLayer(layer);
  };

  const addShape = () => {
    const w = Math.round(size.width * 0.5);
    addLayer(shapeLayer({ x: Math.round((size.width - w) / 2), y: Math.round((size.height - w * 0.6) / 2), w, h: Math.round(w * 0.6), fill: brandSwatches(brand)[0] }));
  };

  const addLogo = () => {
    if (!logoAssetId) return toast(brand ? `${brand.name} için kayıtlı bir logo yok.` : 'Önce sağdan bir marka seçin.');
    const m = Math.round(size.width * 0.07);
    addLayer(logoLayer(logoAssetId, m, m, Math.round(size.width * 0.16)));
  };

  const applyLayout = (templateId: string) => {
    const template = TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    change(applyTemplate(doc, template, { ...size, brand, logoAssetId, headline, subline }));
    setSelectedId(null);
  };

  const generateBackground = async () => {
    const aspect = nearestAspect(`${size.width}:${size.height}`, ASPECTS.map((a) => a.id));
    const job = await attempt(() =>
      api.post<Job>('/api/generate', { type: 'image', prompt: bgPrompt, userPrompt: bgPrompt, aspect, count: 1, entityIds: [] }),
    );
    if (job) setBgJob(job.id);
  };

  const onBackgroundDone = useCallback(
    (job: Job) => {
      setBgJob(null);
      if (job.status !== 'succeeded' || !job.assetIds[0]) {
        if (job.error) toast(job.error, 'error');
        return;
      }
      const layer: ImageLayer = {
        id: newId(), type: 'image', assetId: job.assetIds[0], x: 0, y: 0, ...{ w: size.width, h: size.height },
        rotation: 0, opacity: 1, fit: 'cover', focusX: 0.5, focusY: 0.5, radius: 0,
      };
      addLayer(layer, true);
      setBgPrompt('');
    },
    [addLayer, size.width, size.height],
  );

  // ── Dışa aktarma ──

  const fileName = `${(name || 'tasarim').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60)}.png`;

  const download = async () => {
    setExporting('download');
    try {
      const blob = await exportDesign(doc, size.width, size.height, store.current);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Dışa aktarılamadı.', 'error');
    } finally {
      setExporting(null);
    }
  };

  const saveToLibrary = async (thenPost = false) => {
    if (!design) return;
    setExporting(thenPost ? 'post' : 'library');
    try {
      const blob = await exportDesign(doc, size.width, size.height, store.current);
      const [asset] = await uploadFiles([new File([blob], fileName, { type: 'image/png' })], { source: 'design', title: name || 'Tasarım' });
      if (!asset) return;
      await api.patch(`/api/designs/${design.id}`, { assetId: asset.id });
      void queryClient.invalidateQueries({ queryKey: keys.designs });
      if (thenPost) {
        const post = await api.post<Post>('/api/posts', { assetIds: [asset.id], title: name, brandId, designId: design.id });
        navigate(`/icerik/${post.id}`);
      } else {
        toast('Tasarım kütüphaneye kaydedildi.', 'ok');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Kaydedilemedi.', 'error');
    } finally {
      setExporting(null);
    }
  };

  const presetLabel = useMemo(() => SIZE_PRESETS.find((p) => p.width === size.width && p.height === size.height)?.label, [size]);

  if (query.isLoading) return <PageLoader />;
  if (!design || design.deletedAt) {
    return <Empty className="pt-28" title="Tasarım bulunamadı" action={<Link to="/tasarim" className="btn btn-primary">Tasarımlara dön</Link>} />;
  }

  const handles: Handle[] = selected?.type === 'text' ? ['nw', 'ne', 'sw', 'se', 'e', 'w'] : ['nw', 'ne', 'sw', 'se'];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 flex-none items-center gap-2 border-b border-line px-3">
        <Link to="/tasarim" className="btn btn-ghost btn-sm">
          <ArrowLeft /> Tasarımlar
        </Link>
        <input
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[0.98rem] font-semibold outline-none hover:bg-sunken focus:bg-sunken sm:max-w-72"
          aria-label="Tasarım adı"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <span className="flex items-center gap-1.5 text-[0.78rem] text-ink-3 max-md:hidden" aria-live="polite">
          {saveState === 'saving' && <><Spinner className="!h-3 !w-3" /> Kaydediliyor</>}
          {saveState === 'saved' && <><Check className="h-3.5 w-3.5 text-ok" /> Kaydedildi</>}
        </span>
        <span className="flex-1" />
        <IconButton label="Geri al (⌘Z)" size="sm" disabled={!past.current.length} onClick={undo}><Undo2 /></IconButton>
        <IconButton label="Yinele (⇧⌘Z)" size="sm" disabled={!future.current.length} onClick={redo}><Redo2 /></IconButton>
        <button type="button" className="btn btn-outline btn-sm" disabled={!!exporting} onClick={download}>
          {exporting === 'download' ? <Spinner /> : <Download />} <span className="max-sm:hidden">PNG indir</span>
        </button>
        <button type="button" className="btn btn-outline btn-sm" disabled={!!exporting} onClick={() => void saveToLibrary(true)}>
          {exporting === 'post' ? <Spinner /> : <Newspaper />} <span className="max-md:hidden">Gönderi yap</span>
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!!exporting} onClick={() => void saveToLibrary()}>
          {exporting === 'library' ? <Spinner /> : <Save />} <span className="max-sm:hidden">Kütüphaneye kaydet</span>
        </button>
      </header>

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="flex flex-none flex-col gap-1 border-r border-line p-2 max-md:flex-row max-md:border-r-0 max-md:border-b">
          {[
            { label: 'Görsel', icon: <ImageIcon />, run: () => void addImage() },
            { label: 'Metin', icon: <Type />, run: addText },
            { label: 'Şekil', icon: <Square />, run: addShape },
            { label: 'Logo', icon: <Stamp />, run: addLogo },
          ].map((tool) => (
            <button
              key={tool.label}
              type="button"
              onClick={tool.run}
              className="flex w-[4.2rem] flex-col items-center gap-1 rounded-lg py-2.5 text-[0.74rem] text-ink-2 transition-colors hover:bg-sunken hover:text-ink [&>svg]:h-5 [&>svg]:w-5"
            >
              {tool.icon}
              {tool.label}
            </button>
          ))}
          <Popover
            placement="bottom-start"
            className="w-80 !p-3.5"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                className="flex w-[4.2rem] flex-col items-center gap-1 rounded-lg py-2.5 text-[0.74rem] text-accent-text transition-colors hover:bg-accent-soft [&>svg]:h-5 [&>svg]:w-5"
              >
                <Sparkles />
                Üret
              </button>
            )}
          >
            {(close) => (
              <div className="flex flex-col gap-2.5">
                <p className="text-[0.86rem] font-medium">Yapay zekâyla arka plan üret</p>
                <textarea
                  autoFocus
                  className="input !text-[0.9rem]"
                  rows={3}
                  placeholder="Örn. Mermer tezgâhta buharı tüten bir fincan kahve, sabah ışığı, üstte metin için boşluk"
                  value={bgPrompt}
                  onChange={(event) => setBgPrompt(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-accent btn-sm self-end"
                  disabled={!bgPrompt.trim() || !!bgJob}
                  onClick={() => {
                    void generateBackground();
                    close();
                  }}
                >
                  <Sparkles /> Üret ve yerleştir
                </button>
              </div>
            )}
          </Popover>
          {bgJob && <div className="mt-1 w-[4.2rem] max-md:w-auto"><BackgroundJob jobId={bgJob} onDone={onBackgroundDone} /></div>}
        </div>

        <div ref={stage} className="relative grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden bg-stage" onPointerDown={(event) => event.target === event.currentTarget && setSelectedId(null)}>
          <div className="relative shadow-[0_12px_60px_oklch(0_0_0/0.5)]" style={{ width: size.width * scale, height: size.height * scale }}>
            <canvas ref={canvas} className="block h-full w-full" />
            <div
              ref={overlay}
              className="absolute inset-0 touch-none"
              style={{ cursor: drag.current?.mode === 'move' ? 'grabbing' : 'default' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {guides.x !== null && <span className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent" style={{ left: guides.x * scale }} />}
              {guides.y !== null && <span className="pointer-events-none absolute right-0 left-0 h-px bg-accent" style={{ top: guides.y * scale }} />}
              {selected && !selected.hidden && (
                <div
                  className="pointer-events-none absolute border-[1.5px] border-accent"
                  style={{
                    left: selected.x * scale,
                    top: selected.y * scale,
                    width: selected.w * scale,
                    height: selected.h * scale,
                    transform: selected.rotation ? `rotate(${selected.rotation}deg)` : undefined,
                  }}
                >
                  {handles.map((handle) => (
                    <span
                      key={handle}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        onPointerDown(event, handle);
                      }}
                      className={cx(
                        'pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 border-[1.5px] border-accent bg-white',
                        handle.length === 1 ? 'h-5 w-2 rounded-full' : 'h-3 w-3 rounded-full',
                      )}
                      style={{ left: HANDLE_POS[handle].left, top: HANDLE_POS[handle].top, cursor: HANDLE_POS[handle].cursor }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          <span className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/50 px-2 py-1 font-mono text-[0.72rem] text-white/80">
            {size.width} × {size.height} · %{Math.round(scale * 100)}
          </span>
        </div>

        <aside className="w-[19.5rem] flex-none overflow-y-auto border-l border-line bg-surface max-md:max-h-[42dvh] max-md:w-full max-md:border-t max-md:border-l-0">
          {selected ? (
            <>
              {selected.type === 'text' && <TextPanel layer={selected} brand={brand} onChange={(patch) => patchLayer(selected.id, patch)} />}
              {selected.type === 'image' && (
                <ImagePanel
                  layer={selected}
                  brand={brand}
                  onChange={(patch) => patchLayer(selected.id, patch)}
                  onFill={() => patchLayer(selected.id, { x: 0, y: 0, w: size.width, h: size.height, rotation: 0 })}
                />
              )}
              {selected.type === 'shape' && <ShapePanel layer={selected} brand={brand} onChange={(patch) => patchLayer(selected.id, patch)} />}
              <ArrangePanel
                layer={selected}
                onChange={(patch) => patchLayer(selected.id, patch)}
                onOrder={(step) => reorder(selected.id, step)}
                onDuplicate={() => duplicate(selected.id)}
                onDelete={() => removeLayer(selected.id)}
              />
            </>
          ) : (
            <>
              <PanelSection title="Tuval">
                <Row label="Boyut">
                  <Popover
                    placement="bottom-end"
                    className="w-[21rem] p-3.5"
                    trigger={(props) => (
                      <button type="button" className="input !h-8 !w-44 text-left !text-[0.84rem]" {...props}>
                        <span className="block truncate">{presetLabel ?? `${size.width} × ${size.height}`}</span>
                      </button>
                    )}
                  >
                    {() => (
                      <SizePicker
                        pixelsOnly
                        value={{ aspect: ratioOf(size.width, size.height), width: size.width, height: size.height }}
                        onChange={(value) => value.width && value.height && setSize({ width: value.width, height: value.height })}
                        customHint="Katmanlar yerinde kalır; tuval bu ölçüye getirilir."
                      />
                    )}
                  </Popover>
                </Row>
                <Row label="Marka">
                  <select className="input !h-8 !w-44 !text-[0.84rem]" value={brandId ?? ''} onChange={(event) => setBrandId(event.target.value || null)}>
                    <option value="">Marka yok</option>
                    {brands.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </Row>
                <Row label="Zemin">
                  <ColorField label="Zemin rengi" value={doc.background} swatches={brandSwatches(brand)} onChange={(background) => change({ ...doc, background })} />
                </Row>
              </PanelSection>

              <PanelSection title="Hazır düzenler">
                <input className="input !h-8 !text-[0.86rem]" aria-label="Başlık" placeholder="Başlık" value={headline} onChange={(event) => setHeadline(event.target.value)} />
                <input className="input !h-8 !text-[0.86rem]" aria-label="Alt metin" placeholder="Alt metin" value={subline} onChange={(event) => setSubline(event.target.value)} />
                <div className="-mx-1.5 flex flex-col">
                  {TEMPLATES.map((template) => (
                    <button key={template.id} type="button" className="menu-item !items-start" onClick={() => applyLayout(template.id)}>
                      <LayoutTemplate className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="block text-[0.88rem] font-medium">{template.label}</span>
                        <span className="block text-[0.78rem] leading-snug text-ink-3">{template.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="hint">Düzen, tasarımdaki fotoğrafı korur; marka seçiliyse renkleri, yazı tiplerini ve logoyu kullanır.</p>
              </PanelSection>

              <PanelSection title="Katmanlar">
                <LayerList
                  doc={doc}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onToggle={(layerId) => patchLayer(layerId, { hidden: !doc.layers.find((l) => l.id === layerId)?.hidden })}
                />
              </PanelSection>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
