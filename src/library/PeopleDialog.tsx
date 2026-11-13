import { Lasso, MousePointerClick, ScanFace, SquareDashed, Trash2, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ENTITY_TYPES } from '../../shared/platforms.ts';
import type { Asset, DetectedPerson, Entity, EntityType, NormalizedBox, PeopleDetection } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { queryClient, refreshApp, useApp } from '../lib/queries.ts';
import { confirmDialog, toast, useUI } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { IconButton, Segmented, Spinner, Switch } from '../ui/kit.tsx';
import { uploadFiles } from './upload.ts';

type Tool = 'click' | 'box' | 'lasso';
type Framing = 'portrait' | 'body';
type Point = [number, number];

interface Selection {
  id: string;
  kind: 'rect' | 'lasso';
  /** Kutu; serbest çizimde çizginin sınır kutusu. */
  box: NormalizedBox;
  points?: Point[];
  /** Otomatik bulunan kişiden geldiyse onun sırası. */
  person?: number;
  /** Kullanıcı kutuyu elle değiştirdi; kadraj değişince artık yeniden hesaplanmaz. */
  touched?: boolean;
  /** 'new': yeni varlık · '': yalnızca kütüphane · diğer: var olan varlığın kimliği. */
  target: string;
  name: string;
  type: EntityType;
  /** Serbest çizimde çizginin dışı kırpımdan silinsin mi. */
  isolate: boolean;
}

type Drag =
  | { kind: 'pick'; x: number; y: number }
  | { kind: 'draw'; id: string; startX: number; startY: number }
  | { kind: 'move'; id: string; offsetX: number; offsetY: number; x: number; y: number; moved: boolean }
  | { kind: 'resize'; id: string; anchorX: number; anchorY: number }
  | { kind: 'lasso' };

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const inside = (x: number, y: number, box: NormalizedBox) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
const newId = () => `s${Date.now().toString(36)}${Math.round(Math.random() * 1e6).toString(36)}`;
const same = (a: string, b: string) => a.trim().toLocaleLowerCase('tr') === b.trim().toLocaleLowerCase('tr');

const HANDLES: { id: string; x: 0 | 1; y: 0 | 1; cursor: string }[] = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
];

function frameOf(person: DetectedPerson, framing: Framing): NormalizedBox {
  const box = framing === 'body' && person.body ? person.body : person;
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

/** Tıklanan noktadaki kişi: kutusu noktayı içerenlerden, yüzü en yakın olan. */
function personAt(people: DetectedPerson[], x: number, y: number, aspect: number): number {
  let best = -1;
  let bestDistance = Infinity;
  people.forEach((person, index) => {
    if (!inside(x, y, person) && !(person.body && inside(x, y, person.body))) return;
    const anchor = person.face ?? person;
    const dx = (anchor.x + anchor.w / 2 - x) * aspect;
    const dy = anchor.y + anchor.h / 2 - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

function boundsOf(points: Point[]): NormalizedBox {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Seçimi özgün çözünürlükte (ya da küçültülmüş önizleme olarak) tuvale çizer. */
function drawCrop(canvas: HTMLCanvasElement, image: HTMLImageElement, selection: Pick<Selection, 'kind' | 'box' | 'points' | 'isolate'>, maxEdge?: number): void {
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  const sx = Math.round(selection.box.x * W);
  const sy = Math.round(selection.box.y * H);
  const sw = Math.max(1, Math.min(W - sx, Math.round(selection.box.w * W)));
  const sh = Math.max(1, Math.min(H - sy, Math.round(selection.box.h * H)));
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(sw, sh)) : 1;
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  if (selection.kind === 'lasso' && selection.isolate && selection.points?.length) {
    // Çizginin dışı nötr bir zeminle doldurulur; referansa başkası karışmaz.
    ctx.fillStyle = '#f1f1f1';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    selection.points.forEach(([px, py], index) => {
      const x = (px * W - sx) * scale;
      const y = (py * H - sy) * scale;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function Thumb({ image, selection }: { image: HTMLImageElement | null; selection: Selection }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { box, points, isolate, kind } = selection;
  useEffect(() => {
    if (image && ref.current && box.w > 0 && box.h > 0) drawCrop(ref.current, image, { kind, box, points, isolate }, 144);
  }, [image, kind, box, points, isolate]);
  const ratio = image && box.h > 0 ? (box.w * image.naturalWidth) / (box.h * image.naturalHeight) : 1;
  return <canvas ref={ref} aria-hidden className="h-14 flex-none rounded-md bg-sunken object-cover" style={{ width: `${clamp(3.5 * ratio, 2.2, 4.6)}rem` }} />;
}

/**
 * Bir fotoğraftaki kişileri seçip her birini bir kişiye atar. Üç yol vardır:
 * kişiye tıklamak (Bellek kadrajı kendisi bulur), kutu çizmek ya da çevresini
 * serbestçe çizmek. Her seçim ayrı bir kırpım olarak kaydedilir; özgün görsel değişmez.
 */
export function PeopleDialog({ asset, open, onClose }: { asset: Asset | null; open: boolean; onClose: () => void }) {
  const app = useApp();
  const entities = app.entities;
  const maskId = useId();
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const lasso = useRef<Point[]>([]);
  const modelTried = useRef(false);
  const [tool, setTool] = useState<Tool>('click');
  const [framing, setFraming] = useState<Framing>('portrait');
  const [selections, setSelections] = useState<Selection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState(-1);
  const [drawing, setDrawing] = useState<Point[] | null>(null);
  const [detection, setDetection] = useState<PeopleDetection | null>(null);
  const [detecting, setDetecting] = useState<'auto' | 'model' | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [checked, setChecked] = useState(false);

  const assetId = asset?.id;
  const assetUrl = asset?.url;
  const ratio = asset?.width && asset.height ? asset.width / asset.height : image ? image.naturalWidth / image.naturalHeight : 1;
  const people = detection?.people ?? [];
  const canModel = app.models.some((m) => m.model.kind === 'text' && m.model.vision !== false);
  const hasBodies = people.some((person) => person.body);

  // Pencere her açıldığında temiz başlar; ücretsiz yerel algılama hemen denenir.
  useEffect(() => {
    if (!open || !assetId || !assetUrl) return;
    let cancelled = false;
    setSelections([]);
    setActiveId(null);
    setHover(-1);
    setDrawing(null);
    setDetection(null);
    setSaving(null);
    setChecked(false);
    setTool('click');
    modelTried.current = false;
    setImage(null);
    const loaded = new Image();
    loaded.src = assetUrl;
    void loaded.decode().then(() => !cancelled && setImage(loaded)).catch(() => undefined);
    setDetecting('auto');
    api
      .post<PeopleDetection>(`/api/assets/${assetId}/detect`, { allowModel: false })
      .then((result) => !cancelled && setDetection(result))
      .catch(() => !cancelled && setDetection({ people: [], method: 'none' }))
      .finally(() => !cancelled && setDetecting(null));
    return () => {
      cancelled = true;
    };
  }, [open, assetId, assetUrl]);

  const askModel = useCallback(async (): Promise<DetectedPerson[]> => {
    if (!assetId) return [];
    modelTried.current = true;
    setDetecting('model');
    try {
      const result = await api.post<PeopleDetection>(`/api/assets/${assetId}/detect`, { allowModel: true });
      setDetection(result);
      return result.people;
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Kişiler bulunamadı.', 'error');
      return [];
    } finally {
      setDetecting(null);
    }
  }, [assetId]);

  const patch = (id: string, change: Partial<Selection>) => setSelections((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));
  const remove = (id: string) => {
    setSelections((list) => list.filter((item) => item.id !== id));
    setActiveId((current) => (current === id ? null : current));
  };

  const add = (partial: Pick<Selection, 'kind' | 'box'> & Partial<Selection>): Selection => {
    // Görsel zaten tek bir varlığın referansıysa ilk seçim büyük olasılıkla ona aittir.
    const linked = asset?.entityIds.find((id) => entities.some((e) => e.id === id));
    const selection: Selection = {
      id: newId(), target: linked && !selections.length ? linked : 'new', name: '', type: 'person', isolate: true, ...partial,
    };
    setSelections((list) => [...list, selection]);
    setActiveId(selection.id);
    return selection;
  };

  // Kadraj değişince, elle dokunulmamış otomatik seçimler yeni kadraja geçer.
  useEffect(() => {
    setSelections((list) =>
      list.map((item) => (item.person !== undefined && !item.touched && people[item.person] ? { ...item, box: frameOf(people[item.person], framing) } : item)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framing]);

  const pick = async (x: number, y: number) => {
    let found = people;
    let index = personAt(found, x, y, ratio);
    if (index < 0) {
      // Kişi değil ama var olan bir seçimin içi tıklandıysa o seçim öne alınır.
      const hit = selections.filter((item) => inside(x, y, item.box)).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
      if (hit) return setActiveId(hit.id);
    }
    // Yerel algılama hiç kimseyi bulamadıysa, bağlı model bir kez denenir.
    if (index < 0 && !found.length && canModel && !modelTried.current) {
      found = await askModel();
      index = personAt(found, x, y, ratio);
    }
    if (index >= 0) {
      const existing = selections.find((item) => item.person === index);
      if (existing) return setActiveId(existing.id);
      add({ kind: 'rect', box: frameOf(found[index], framing), person: index });
      return;
    }
    // Kimse algılanmadıysa tıklanan yere ayarlanabilir bir portre kutusu konur.
    const w = Math.min(0.9, ratio >= 1 ? 0.2 : 0.34);
    const h = Math.min(0.9, w * ratio * 1.3);
    add({ kind: 'rect', box: { x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - h * 0.4, 0, 1 - h), w, h }, touched: true });
    toast('Burada kişi algılanmadı; kutuyu sürükleyip köşelerinden ayarlayabilirsiniz.');
  };

  const point = (event: React.PointerEvent): { x: number; y: number } => {
    const box = stage.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
  };

  const active = selections.find((item) => item.id === activeId) ?? null;

  const onDown = (event: React.PointerEvent, handle?: { x: 0 | 1; y: 0 | 1 }) => {
    if (event.button !== 0 || saving) return;
    event.preventDefault();
    event.stopPropagation();
    stage.current?.setPointerCapture(event.pointerId);
    const p = point(event);
    if (handle && active?.kind === 'rect') {
      // Sürüklenen köşenin karşısındaki köşe sabit kalır.
      drag.current = { kind: 'resize', id: active.id, anchorX: handle.x ? active.box.x : active.box.x + active.box.w, anchorY: handle.y ? active.box.y : active.box.y + active.box.h };
      return;
    }
    if (active?.kind === 'rect' && inside(p.x, p.y, active.box)) {
      drag.current = { kind: 'move', id: active.id, offsetX: p.x - active.box.x, offsetY: p.y - active.box.y, x: p.x, y: p.y, moved: false };
      return;
    }
    if (tool === 'click') {
      drag.current = { kind: 'pick', x: p.x, y: p.y };
    } else if (tool === 'box') {
      const created = add({ kind: 'rect', box: { x: p.x, y: p.y, w: 0, h: 0 }, touched: true });
      drag.current = { kind: 'draw', id: created.id, startX: p.x, startY: p.y };
    } else {
      lasso.current = [[p.x, p.y]];
      setDrawing(lasso.current);
      drag.current = { kind: 'lasso' };
    }
  };

  const onMove = (event: React.PointerEvent) => {
    const state = drag.current;
    const p = point(event);
    if (!state) {
      if (tool === 'click') {
        const next = personAt(people, p.x, p.y, ratio);
        if (next !== hover) setHover(next);
      }
      return;
    }
    if (state.kind === 'move') {
      // Küçük titremeler taşıma sayılmaz; böylece seçili kutunun içindeki başka bir kişiye de tıklanabilir.
      if (!state.moved && Math.hypot((p.x - state.x) * ratio, p.y - state.y) < 0.006) return;
      state.moved = true;
      setSelections((list) =>
        list.map((item) => (item.id === state.id ? { ...item, touched: true, box: { ...item.box, x: clamp(p.x - state.offsetX, 0, 1 - item.box.w), y: clamp(p.y - state.offsetY, 0, 1 - item.box.h) } } : item)),
      );
    } else if (state.kind === 'draw' || state.kind === 'resize') {
      const ax = state.kind === 'draw' ? state.startX : state.anchorX;
      const ay = state.kind === 'draw' ? state.startY : state.anchorY;
      patch(state.id, { touched: true, box: { x: Math.min(ax, p.x), y: Math.min(ay, p.y), w: Math.abs(p.x - ax), h: Math.abs(p.y - ay) } });
    } else if (state.kind === 'lasso') {
      const last = lasso.current[lasso.current.length - 1];
      // Çok sık noktalar çizgiyi ağırlaştırır; belirgin hareketler eklenir.
      if (Math.hypot((p.x - last[0]) * ratio, p.y - last[1]) > 0.004) {
        lasso.current = [...lasso.current, [p.x, p.y]];
        setDrawing(lasso.current);
      }
    }
  };

  const onUp = (event: React.PointerEvent) => {
    const state = drag.current;
    drag.current = null;
    stage.current?.releasePointerCapture(event.pointerId);
    if (!state) return;
    if (state.kind === 'pick') {
      void pick(state.x, state.y);
    } else if (state.kind === 'move') {
      if (!state.moved && tool === 'click') void pick(state.x, state.y);
    } else if (state.kind === 'draw' || state.kind === 'resize') {
      setSelections((list) => list.filter((item) => item.id !== state.id || (item.box.w >= 0.02 && item.box.h >= 0.02)));
    } else if (state.kind === 'lasso') {
      const points = lasso.current;
      lasso.current = [];
      setDrawing(null);
      const box = points.length >= 8 ? boundsOf(points) : null;
      if (box && box.w >= 0.03 && box.h >= 0.03) add({ kind: 'lasso', box, points, touched: true });
      else toast('Kişinin çevresini kesintisiz bir çizgiyle dolaşın.');
    }
  };

  // Seçili kutu klavyeyle silinebilir (yazı alanındayken değil).
  useEffect(() => {
    if (!open || !activeId) return;
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        remove(activeId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeId]);

  const incomplete = selections.filter((item) => item.target === 'new' && !item.name.trim());

  /** Seçim varken yanlışlıkla kapatmak emeği siler; önce sorulur. */
  const requestClose = async () => {
    if (saving) return;
    if (selections.length && !(await confirmDialog({ title: 'Seçimler kaydedilmedi', body: 'Pencereyi kapatırsanız seçtiğiniz kişiler kaydedilmez.', confirm: 'Kaydetmeden kapat', danger: true }))) return;
    onClose();
  };

  const save = async () => {
    if (!asset || !image || !selections.length) return;
    setChecked(true);
    if (incomplete.length) {
      setActiveId(incomplete[0].id);
      return;
    }
    setSaving({ done: 0, total: selections.length });
    const base = asset.filename.replace(/\.[^.]+$/, '');
    const labels: string[] = [];
    // Aynı adla girilen yeni kişiler tek varlıkta toplanır; ad var olan bir varlığa aitse ona eklenir.
    const groups = new Map<string, { name: string; type: EntityType; assetIds: string[] }>();
    const touchedEntities = new Set<string>();
    let saved = 0;
    try {
      for (const [index, selection] of selections.entries()) {
        const canvas = document.createElement('canvas');
        drawCrop(canvas, image, selection);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
        if (!blob) throw new Error('Kırpım oluşturulamadı.');
        const existing = selection.target === 'new' ? entities.find((e) => same(e.name, selection.name) || same(e.handle, selection.name.replace(/^@/, ''))) : entities.find((e) => e.id === selection.target);
        const fields: Record<string, string> = { source: 'crop', parentId: asset.id, title: existing?.name ?? (selection.name.trim() || 'Kişi kırpımı') };
        if (existing) fields.entityId = existing.id;
        const [crop] = await uploadFiles([new File([blob], `${base}-kisi-${index + 1}.jpg`, { type: 'image/jpeg' })], fields);
        if (!crop) throw new Error('Kırpım yüklenemedi.');
        saved += 1;
        if (existing) {
          touchedEntities.add(existing.id);
          labels.push(`@${existing.handle}`);
        } else if (selection.target === 'new') {
          const key = `${selection.type}:${selection.name.trim().toLocaleLowerCase('tr')}`;
          const group = groups.get(key) ?? { name: selection.name.trim(), type: selection.type, assetIds: [] };
          group.assetIds.push(crop.id);
          groups.set(key, group);
        }
        setSaving({ done: index + 1, total: selections.length });
      }
      for (const group of groups.values()) {
        const entity = await api.post<Entity>('/api/entities', { type: group.type, name: group.name, assetIds: group.assetIds });
        labels.push(`@${entity.handle}`);
      }
      const who = [...new Set(labels)];
      toast(
        who.length
          ? `${saved} kırpım kaydedildi: ${who.join(', ')}. Sohbette bu adlarla çağırabilirsiniz.`
          : `${saved} kırpım kütüphaneye kaydedildi.`,
        'ok',
      );
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Kaydedilemedi.', 'error');
    } finally {
      setSaving(null);
      for (const id of touchedEntities) void queryClient.invalidateQueries({ queryKey: ['entity', id] });
      void refreshApp();
    }
  };

  const status = useMemo(() => {
    if (detecting === 'auto') return 'Kişiler aranıyor…';
    if (detecting === 'model') return 'Yapay zekâ görsele bakıyor…';
    if (people.length) return `${people.length} kişi bulundu`;
    if (detection?.method === 'none') return canModel ? '' : 'Otomatik bulma yok; çizerek seçin';
    return detection ? 'Kişi algılanmadı' : '';
  }, [detecting, people.length, detection, canModel]);

  const hint =
    tool === 'click'
      ? people.length
        ? 'Kişinin üzerine tıklayın. Kutuyu sürükleyerek taşıyabilir, köşelerinden ayarlayabilirsiniz.'
        : 'Kişinin üzerine tıklayın; Bellek kadrajı kendisi bulmaya çalışır.'
      : tool === 'box'
        ? 'Kişinin çevresine sürükleyerek bir kutu çizin.'
        : 'Kişinin çevresini serbestçe çizin. Kalabalık fotoğraflarda yalnızca çizdiğiniz kişi kırpıma girer.';

  return (
    <Dialog
      open={open && !!asset}
      onClose={() => void requestClose()}
      size="xl"
      title="Fotoğraftan kişi seç"
      description="Kişileri tıklayarak ya da çizerek seçin, her birinin kim olduğunu söyleyin. Seçimler ayrı referans fotoğrafları olarak kaydedilir; özgün görsel değişmez."
      footer={
        <>
          <span className="mr-auto max-w-[26rem] text-[0.84rem] text-ink-3 max-md:hidden">
            Aynı kişinin farklı açılardan 3–5 net fotoğrafı, tek fotoğraftan çok daha tutarlı sonuç verir.
          </span>
          <button type="button" className="btn btn-outline" onClick={() => void requestClose()}>Vazgeç</button>
          <button type="button" className="btn btn-primary" disabled={!selections.length || !!saving || !image} onClick={save}>
            {saving && <Spinner />}
            {saving ? `Kaydediliyor ${Math.min(saving.done + 1, saving.total)} / ${saving.total}` : selections.length > 1 ? `${selections.length} kişiyi kaydet` : 'Kaydet'}
          </button>
        </>
      }
    >
      {asset && (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0">
            <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Segmented
                size="sm"
                value={tool}
                onChange={(next) => {
                  setTool(next);
                  setHover(-1);
                }}
                options={[
                  { value: 'click', label: 'Tıkla', icon: <MousePointerClick />, title: 'Kişinin üzerine tıklayın' },
                  { value: 'box', label: 'Kutu çiz', icon: <SquareDashed />, title: 'Sürükleyerek kutu çizin' },
                  { value: 'lasso', label: 'Serbest çiz', icon: <Lasso />, title: 'Kişinin çevresini serbestçe çizin' },
                ]}
              />
              {tool === 'click' && hasBodies && (
                <Segmented
                  size="sm"
                  value={framing}
                  onChange={setFraming}
                  options={[
                    { value: 'portrait', label: 'Portre', title: 'Yüz ve omuzlar: kimlik referansı için en iyisi' },
                    { value: 'body', label: 'Tüm vücut', title: 'Kişinin görünen tamamı: kıyafet ve duruş için' },
                  ]}
                />
              )}
              <span className="flex-1" />
              <span className="inline-flex items-center gap-2 text-[0.84rem] text-ink-2" aria-live="polite">
                {detecting && <Spinner className="!h-3.5 !w-3.5" />}
                {status}
              </span>
              {!detecting && detection && !people.length && canModel && detection.method !== 'model' && (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void askModel()}>
                  <ScanFace /> Yapay zekâyla bul
                </button>
              )}
            </div>

            <div className="grid place-items-center rounded-xl bg-stage p-3">
              <div
                ref={stage}
                className="relative max-w-full touch-none select-none"
                style={{ aspectRatio: String(ratio), width: `min(100%, calc(54dvh * ${ratio.toFixed(4)}))`, cursor: tool === 'click' ? (hover >= 0 ? 'pointer' : 'default') : 'crosshair' }}
                onPointerDown={(event) => onDown(event)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={() => !drag.current && setHover(-1)}
              >
                <img src={asset.url} alt="" draggable={false} className="block h-full w-full rounded-md object-fill" />

                <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                  {selections.length > 0 && (
                    <>
                      <mask id={maskId}>
                        <rect width="1000" height="1000" fill="white" />
                        {selections.map((item) =>
                          item.kind === 'lasso' && item.points ? (
                            <polygon key={item.id} points={item.points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ')} fill="black" />
                          ) : (
                            <rect key={item.id} x={item.box.x * 1000} y={item.box.y * 1000} width={item.box.w * 1000} height={item.box.h * 1000} rx="6" fill="black" />
                          ),
                        )}
                      </mask>
                      <rect width="1000" height="1000" fill="black" opacity="0.5" mask={`url(#${maskId})`} />
                    </>
                  )}
                  {selections.map(
                    (item) =>
                      item.kind === 'lasso' &&
                      item.points && (
                        <polygon
                          key={item.id}
                          points={item.points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ')}
                          fill="none"
                          stroke={item.id === activeId ? 'var(--accent)' : 'white'}
                          strokeWidth={item.id === activeId ? 2.5 : 1.75}
                          strokeLinejoin="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      ),
                  )}
                  {drawing && drawing.length > 1 && (
                    <polyline points={drawing.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  )}
                </svg>

                {/* Bulunan ama henüz seçilmemiş kişiler: yüzde küçük bir işaret, üzerine gelince kadraj. */}
                {tool === 'click' &&
                  people.map((person, index) => {
                    if (selections.some((item) => item.person === index)) return null;
                    const anchor = person.face ?? { x: person.x, y: person.y, w: person.w, h: person.h * 0.5 };
                    const frame = frameOf(person, framing);
                    return (
                      <span key={index} className="pointer-events-none">
                        {hover === index && (
                          <span
                            className="absolute rounded-md border-2 border-dashed border-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)]"
                            style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.w * 100}%`, height: `${frame.h * 100}%` }}
                          />
                        )}
                        <span
                          className={cx(
                            'absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)] transition-transform duration-150',
                            hover === index ? 'scale-125 bg-accent' : 'bg-white/30',
                          )}
                          style={{ left: `${(anchor.x + anchor.w / 2) * 100}%`, top: `${(anchor.y + anchor.h / 2) * 100}%` }}
                        />
                      </span>
                    );
                  })}

                {selections.map((item, index) => {
                  const isActive = item.id === activeId;
                  return (
                    <div
                      key={item.id}
                      className={cx(
                        'absolute',
                        item.kind === 'rect' && 'rounded-[5px] border-2',
                        item.kind === 'rect' && (isActive ? 'border-accent' : 'border-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.4)]'),
                        !isActive && 'pointer-events-none',
                      )}
                      style={{ left: `${item.box.x * 100}%`, top: `${item.box.y * 100}%`, width: `${item.box.w * 100}%`, height: `${item.box.h * 100}%`, cursor: isActive && item.kind === 'rect' ? 'move' : undefined }}
                    >
                      <span
                        className={cx(
                          'absolute top-0 left-0 grid h-5 min-w-5 -translate-x-px -translate-y-full place-items-center rounded-t-md px-1 font-mono text-[0.7rem] font-semibold',
                          isActive ? 'bg-accent text-black' : 'bg-white text-black',
                        )}
                      >
                        {index + 1}
                      </span>
                      {isActive &&
                        item.kind === 'rect' &&
                        HANDLES.map((handle) => (
                          <span
                            key={handle.id}
                            onPointerDown={(event) => onDown(event, { x: handle.x, y: handle.y })}
                            className="absolute h-3.5 w-3.5 rounded-full border-2 border-accent bg-white"
                            style={{ left: handle.x ? '100%' : 0, top: handle.y ? '100%' : 0, transform: 'translate(-50%, -50%)', cursor: handle.cursor }}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="hint mt-2">{hint}</p>
          </div>

          <div className="flex min-w-0 flex-col">
            <div className="mb-2 flex items-center justify-between">
              <span className="label !mb-0">Seçilenler</span>
              {selections.length > 0 && <span className="meta">{selections.length}</span>}
            </div>
            {selections.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-line-strong px-4 py-8 text-center">
                <UsersRound className="h-6 w-6 text-ink-3" />
                <p className="mt-2.5 text-[0.9rem] leading-relaxed text-ink-2">
                  Henüz kimse seçilmedi. Fotoğrafta bir kişiye tıklayın ya da çevresini çizin; burada kim olduğunu söylersiniz.
                </p>
              </div>
            ) : (
              <ul className="-mr-1 flex max-h-[58dvh] flex-col gap-2 overflow-y-auto pr-1">
                {selections.map((item, index) => {
                  const isActive = item.id === activeId;
                  const missing = checked && item.target === 'new' && !item.name.trim();
                  const size = image ? [Math.round(item.box.w * image.naturalWidth), Math.round(item.box.h * image.naturalHeight)] : null;
                  const small = size && item.box.w >= 0.02 && item.box.h >= 0.02 && Math.min(size[0], size[1]) < 280 ? size : null;
                  return (
                    <li
                      key={item.id}
                      className={cx('rounded-xl border bg-surface p-2.5 transition-colors', isActive ? 'border-ink' : 'border-line')}
                      onPointerDown={() => setActiveId(item.id)}
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="relative flex-none">
                          <Thumb image={image} selection={item} />
                          <span className="absolute -top-1 -left-1 grid h-[1.15rem] min-w-[1.15rem] place-items-center rounded-full bg-ink px-1 font-mono text-[0.66rem] font-semibold text-bg">
                            {index + 1}
                          </span>
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                          <select
                            className="input !h-8 !text-[0.86rem]"
                            aria-label={`${index + 1}. seçim kimin`}
                            value={item.target === 'new' ? `new:${item.type}` : item.target}
                            onChange={(event) => {
                              const value = event.target.value;
                              if (value.startsWith('new:')) patch(item.id, { target: 'new', type: value.slice(4) as EntityType });
                              else patch(item.id, { target: value });
                            }}
                          >
                            <optgroup label="Yeni oluştur">
                              {ENTITY_TYPES.map((type) => (
                                <option key={type.id} value={`new:${type.id}`}>
                                  Yeni {type.label.toLocaleLowerCase('tr')}…
                                </option>
                              ))}
                            </optgroup>
                            {entities.length > 0 && (
                              <optgroup label="Var olanlara ekle">
                                {entities.map((entity) => (
                                  <option key={entity.id} value={entity.id}>
                                    {entity.name} (@{entity.handle})
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <option value="">Yalnızca kütüphaneye</option>
                          </select>
                          {item.target === 'new' && (
                            <input
                              className="input !h-8 !text-[0.86rem]"
                              placeholder="Adı, örn. Özge Şahin"
                              aria-label={`${index + 1}. seçimin adı`}
                              aria-invalid={missing}
                              autoFocus={isActive}
                              value={item.name}
                              onChange={(event) => patch(item.id, { name: event.target.value })}
                              onKeyDown={(event) => event.key === 'Enter' && void save()}
                            />
                          )}
                          {missing && <span className="text-[0.78rem] text-danger">Bir ad yazın ya da listeden seçin.</span>}
                          {small && (
                            <span className="text-[0.78rem] leading-snug text-warn">
                              Kırpım küçük ({small[0]}×{small[1]} px). Yüzün daha büyük göründüğü bir fotoğraf daha net referans olur.
                            </span>
                          )}
                          {item.kind === 'lasso' && (
                            <label className="flex items-center justify-between gap-2 text-[0.82rem] text-ink-2">
                              Çizimin dışını temizle
                              <Switch checked={item.isolate} label="Çizimin dışını temizle" onChange={(isolate) => patch(item.id, { isolate })} />
                            </label>
                          )}
                        </div>
                        <IconButton label={`${index + 1}. seçimi kaldır`} size="sm" className="-mt-0.5 -mr-1" onClick={() => remove(item.id)}>
                          <Trash2 />
                        </IconButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Uygulamanın her yerinden `useUI.getState().openPeople(asset)` ile açılır. */
export function PeopleDialogHost() {
  const asset = useUI((state) => state.peopleAsset);
  const close = useUI((state) => state.closePeople);
  return <PeopleDialog asset={asset} open={!!asset} onClose={close} />;
}
