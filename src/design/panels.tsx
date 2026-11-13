import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Copy, Eye, EyeOff, Image as ImageIcon, Maximize, Square, Trash2, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DesignDoc, Entity, ImageLayer, Layer, ShapeLayer, TextLayer } from '../../shared/types.ts';
import { cx } from '../lib/format.ts';
import { pickAssets } from '../lib/store.ts';
import { IconButton, Segmented, Switch } from '../ui/kit.tsx';
import { FONT_CHOICES, fontLabel } from './render.ts';

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="flex-none text-[0.84rem] text-ink-2">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5">{children}</span>
    </label>
  );
}

export function PanelSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4 last:border-0">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[0.8rem] font-semibold text-ink-3">{title}</h3>
        {actions}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

export function NumberField({ value, onChange, min, max, step = 1, label, width = 'w-[4.6rem]' }: { value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; label: string; width?: string }) {
  return (
    <input
      type="number"
      aria-label={label}
      className={cx('input !h-8 !px-2 text-right font-mono !text-[0.82rem]', width)}
      value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
      min={min}
      max={max}
      step={step}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)));
      }}
    />
  );
}

export function Slider({ value, onChange, min, max, step = 1, label }: { value: number; onChange: (value: number) => void; min: number; max: number; step?: number; label: string }) {
  return (
    <input
      type="range"
      aria-label={label}
      className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-line accent-[var(--ink)]"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

export function brandSwatches(brand: Entity | null): string[] {
  return [...new Set([...(brand?.data.colors?.map((c) => c.hex) ?? []), '#FFFFFF', '#111111'])];
}

export function ColorField({ value, onChange, swatches, label, allowNone }: { value: string; onChange: (value: string) => void; swatches: string[]; label: string; allowNone?: boolean }) {
  const base = /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : '#888888';
  const alpha = /^#[0-9a-f]{8}$/i.test(value) ? value.slice(7) : '';
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={label}
          className="h-8 w-9 cursor-pointer rounded-md border border-line bg-transparent p-0.5"
          value={base}
          onChange={(event) => onChange(event.target.value.toUpperCase() + alpha)}
        />
        <input
          className="input !h-8 !w-[6.4rem] !px-2 font-mono !text-[0.8rem]"
          aria-label={`${label} hex`}
          placeholder={allowNone ? 'yok' : '#RRGGBB'}
          value={value}
          maxLength={9}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {allowNone && (
          <button type="button" title="Yok" aria-label="Renk yok" onClick={() => onChange('')} className={cx('h-5 w-5 rounded-full border border-line bg-[linear-gradient(135deg,transparent_45%,var(--danger)_45%,var(--danger)_55%,transparent_55%)]', !value && 'ring-2 ring-accent-text ring-offset-1 ring-offset-surface')} />
        )}
        {swatches.map((swatch) => (
          <button
            key={swatch}
            type="button"
            title={swatch}
            aria-label={swatch}
            onClick={() => onChange(swatch + alpha)}
            className={cx('h-5 w-5 rounded-full border border-line', base.toUpperCase() === swatch.toUpperCase() && 'ring-2 ring-accent-text ring-offset-1 ring-offset-surface')}
            style={{ background: swatch }}
          />
        ))}
      </div>
    </div>
  );
}

interface LayerPanelProps<T extends Layer> {
  layer: T;
  onChange: (patch: Partial<T>) => void;
  brand: Entity | null;
}

export function TextPanel({ layer, onChange, brand }: LayerPanelProps<TextLayer>) {
  const fonts = [...new Set([brand?.data.fonts?.heading, brand?.data.fonts?.body, ...FONT_CHOICES, layer.font].filter((f): f is string => !!f?.trim()))];
  const swatches = brandSwatches(brand);
  return (
    <>
      <PanelSection title="Metin">
        <textarea className="input !text-[0.92rem]" rows={3} aria-label="Metin" value={layer.text} onChange={(event) => onChange({ text: event.target.value })} />
        <Row label="Yazı tipi">
          <select className="input !h-8 !w-40 !text-[0.84rem]" value={layer.font} onChange={(event) => onChange({ font: event.target.value })}>
            {fonts.map((font) => (
              <option key={font} value={font}>{fontLabel(font)}</option>
            ))}
          </select>
        </Row>
        <Row label="Boyut">
          <Slider label="Boyut" value={layer.size} min={12} max={320} onChange={(size) => onChange({ size })} />
          <NumberField label="Boyut" value={layer.size} min={6} max={600} onChange={(size) => onChange({ size })} width="w-14" />
        </Row>
        <Row label="Kalınlık">
          <select className="input !h-8 !w-40 !text-[0.84rem]" value={layer.weight} onChange={(event) => onChange({ weight: Number(event.target.value) })}>
            {[[400, 'Normal'], [500, 'Orta'], [600, 'Yarı kalın'], [700, 'Kalın'], [800, 'Çok kalın'], [900, 'Siyah']].map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Row>
        <Row label="Hizalama">
          <Segmented
            size="sm"
            value={layer.align}
            onChange={(align) => onChange({ align })}
            options={[
              { value: 'left', label: '', icon: <AlignLeft />, title: 'Sola' },
              { value: 'center', label: '', icon: <AlignCenter />, title: 'Ortala' },
              { value: 'right', label: '', icon: <AlignRight />, title: 'Sağa' },
            ]}
          />
        </Row>
        <Row label="Renk">
          <ColorField label="Metin rengi" value={layer.color} swatches={swatches} onChange={(color) => onChange({ color })} />
        </Row>
        <Row label="Satır aralığı">
          <Slider label="Satır aralığı" value={layer.lineHeight} min={0.85} max={2} step={0.01} onChange={(lineHeight) => onChange({ lineHeight })} />
        </Row>
        <Row label="Harf aralığı">
          <Slider label="Harf aralığı" value={layer.letterSpacing} min={-6} max={24} step={0.5} onChange={(letterSpacing) => onChange({ letterSpacing })} />
        </Row>
        <Row label="Büyük harf">
          <Switch checked={layer.uppercase} label="Büyük harf" onChange={(uppercase) => onChange({ uppercase })} />
        </Row>
        <Row label="Gölge">
          <Switch checked={layer.shadow} label="Gölge" onChange={(shadow) => onChange({ shadow })} />
        </Row>
      </PanelSection>
      <PanelSection title="Dolgu">
        <Row label="Arka plan">
          <ColorField label="Arka plan" value={layer.background} swatches={swatches} allowNone onChange={(background) => onChange({ background, padding: background && !layer.padding ? Math.round(layer.size * 0.45) : layer.padding })} />
        </Row>
        {layer.background && (
          <>
            <Row label="İç boşluk">
              <Slider label="İç boşluk" value={layer.padding} min={0} max={160} onChange={(padding) => onChange({ padding })} />
            </Row>
            <Row label="Köşe">
              <Slider label="Köşe" value={layer.radius} min={0} max={160} onChange={(radius) => onChange({ radius })} />
            </Row>
          </>
        )}
      </PanelSection>
    </>
  );
}

export function ImagePanel({ layer, onChange, onFill }: LayerPanelProps<ImageLayer> & { onFill: () => void }) {
  return (
    <PanelSection title="Görsel">
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-outline btn-sm flex-1"
          onClick={async () => {
            const [assetId] = await pickAssets({ title: 'Görseli değiştir', multiple: false, kind: 'image' });
            if (assetId) onChange({ assetId });
          }}
        >
          <ImageIcon /> Değiştir
        </button>
        <button type="button" className="btn btn-outline btn-sm flex-1" onClick={onFill}>
          <Maximize /> Tuvale yay
        </button>
      </div>
      <Row label="Yerleşim">
        <Segmented size="sm" value={layer.fit} onChange={(fit) => onChange({ fit })} options={[{ value: 'cover', label: 'Doldur' }, { value: 'contain', label: 'Sığdır' }]} />
      </Row>
      {layer.fit === 'cover' && (
        <>
          <Row label="Odak yatay">
            <Slider label="Odak yatay" value={layer.focusX} min={0} max={1} step={0.01} onChange={(focusX) => onChange({ focusX })} />
          </Row>
          <Row label="Odak dikey">
            <Slider label="Odak dikey" value={layer.focusY} min={0} max={1} step={0.01} onChange={(focusY) => onChange({ focusY })} />
          </Row>
        </>
      )}
      <Row label="Köşe">
        <Slider label="Köşe" value={layer.radius} min={0} max={400} onChange={(radius) => onChange({ radius })} />
      </Row>
    </PanelSection>
  );
}

export function ShapePanel({ layer, onChange, brand }: LayerPanelProps<ShapeLayer>) {
  const swatches = brandSwatches(brand);
  return (
    <PanelSection title="Şekil">
      <Row label="Biçim">
        <Segmented size="sm" value={layer.shape} onChange={(shape) => onChange({ shape })} options={[{ value: 'rect', label: 'Dikdörtgen' }, { value: 'ellipse', label: 'Elips' }]} />
      </Row>
      <Row label="Renk">
        <ColorField label="Şekil rengi" value={layer.fill} swatches={swatches} onChange={(fill) => onChange({ fill })} />
      </Row>
      <Row label="Geçiş">
        <Switch checked={!!layer.fill2} label="Renk geçişi" onChange={(on) => onChange({ fill2: on ? `${layer.fill.slice(0, 7)}00` : '' })} />
      </Row>
      {layer.fill2 && (
        <>
          <Row label="İkinci renk">
            <ColorField label="İkinci renk" value={layer.fill2} swatches={swatches} onChange={(fill2) => onChange({ fill2 })} />
          </Row>
          <Row label="Açı">
            <Slider label="Açı" value={layer.angle} min={0} max={360} onChange={(angle) => onChange({ angle })} />
          </Row>
        </>
      )}
      {layer.shape === 'rect' && (
        <Row label="Köşe">
          <Slider label="Köşe" value={layer.radius} min={0} max={400} onChange={(radius) => onChange({ radius })} />
        </Row>
      )}
    </PanelSection>
  );
}

export function ArrangePanel({ layer, onChange, onOrder, onDuplicate, onDelete }: { layer: Layer; onChange: (patch: Partial<Layer>) => void; onOrder: (step: number) => void; onDuplicate: () => void; onDelete: () => void }) {
  return (
    <PanelSection
      title="Yerleşim"
      actions={
        <span className="flex gap-0.5">
          <IconButton label="Öne getir" size="sm" onClick={() => onOrder(1)}><ArrowUp /></IconButton>
          <IconButton label="Arkaya gönder" size="sm" onClick={() => onOrder(-1)}><ArrowDown /></IconButton>
          <IconButton label="Çoğalt (⌘D)" size="sm" onClick={onDuplicate}><Copy /></IconButton>
          <IconButton label="Sil" size="sm" onClick={onDelete}><Trash2 /></IconButton>
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        {([['x', 'X'], ['y', 'Y'], ['w', 'G'], ['h', 'Y']] as const).map(([key, label], index) => (
          <label key={key} className="flex items-center gap-2">
            <span className="w-3 text-[0.78rem] text-ink-3">{index === 3 ? 'Y↕' : label}</span>
            <NumberField label={key} value={layer[key]} onChange={(value) => onChange({ [key]: value })} width="w-full" />
          </label>
        ))}
      </div>
      <Row label="Döndür">
        <Slider label="Döndür" value={layer.rotation} min={-180} max={180} onChange={(rotation) => onChange({ rotation })} />
        <NumberField label="Açı" value={layer.rotation} min={-180} max={180} onChange={(rotation) => onChange({ rotation })} width="w-14" />
      </Row>
      <Row label="Saydamlık">
        <Slider label="Saydamlık" value={layer.opacity} min={0} max={1} step={0.01} onChange={(opacity) => onChange({ opacity })} />
      </Row>
    </PanelSection>
  );
}

const LAYER_ICON = { image: ImageIcon, text: Type, shape: Square };

export function LayerList({ doc, selectedId, onSelect, onToggle }: { doc: DesignDoc; selectedId: string | null; onSelect: (id: string) => void; onToggle: (id: string) => void }) {
  if (!doc.layers.length) return <p className="text-[0.84rem] text-ink-3">Henüz katman yok. Soldan görsel, metin ya da şekil ekleyin.</p>;
  return (
    <ul className="-mx-1.5 flex flex-col">
      {[...doc.layers].reverse().map((layer) => {
        const Icon = LAYER_ICON[layer.type];
        const label = layer.type === 'text' ? layer.text.split('\n')[0] || 'Metin' : layer.type === 'image' ? 'Görsel' : layer.shape === 'ellipse' ? 'Elips' : 'Dikdörtgen';
        return (
          <li key={layer.id} className="group/layer flex items-center">
            <button type="button" data-active={layer.id === selectedId} className={cx('menu-item min-w-0 flex-1 !py-1.5', layer.hidden && 'opacity-50')} onClick={() => onSelect(layer.id)}>
              <Icon />
              <span className="truncate text-[0.86rem]">{label}</span>
            </button>
            <IconButton label={layer.hidden ? 'Göster' : 'Gizle'} size="sm" className="opacity-0 group-hover/layer:opacity-100 focus-visible:opacity-100" onClick={() => onToggle(layer.id)}>
              {layer.hidden ? <EyeOff /> : <Eye />}
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}
