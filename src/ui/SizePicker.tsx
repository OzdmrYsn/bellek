import { ArrowLeftRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  ASPECTS, MAX_EDGE, MIN_EDGE, SIZE_PRESETS, aspectToNumber, clampEdge, ratioOf, type SizePreset,
} from '../../shared/platforms.ts';
import { cx } from '../lib/format.ts';
import { Segmented } from './kit.tsx';

export interface SizeValue {
  aspect: string;
  /** Tam piksel ölçüsü; yoksa yalnızca oran geçerlidir. */
  width?: number;
  height?: number;
}

type Tab = 'ratio' | 'preset' | 'custom';

const GROUPS: SizePreset['group'][] = ['Sosyal medya', 'Video', 'Web ve baskı'];

export function sizeLabel(value: SizeValue): string {
  return value.width && value.height ? `${value.width}×${value.height}` : value.aspect;
}

function Glyph({ ratio, box = 16 }: { ratio: number; box?: number }) {
  const width = ratio >= 1 ? box : Math.max(5, Math.round(box * ratio));
  const height = ratio >= 1 ? Math.max(5, Math.round(box / ratio)) : box;
  return <span aria-hidden className="inline-block flex-none rounded-[2.5px] border-[1.5px] border-current" style={{ width, height }} />;
}

/** Oran tek başına verildiğinde özel boyut alanlarını dolduracak makul bir başlangıç. */
function startingSize(aspect: string): { width: number; height: number } {
  const ratio = aspectToNumber(aspect);
  return ratio >= 1 ? { width: Math.round(1080 * ratio), height: 1080 } : { width: 1080, height: Math.round(1080 / ratio) };
}

function EdgeInput({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parsed = Math.round(Number(text));
  const invalid = text !== '' && (!Number.isFinite(parsed) || parsed < MIN_EDGE || parsed > MAX_EDGE);
  return (
    <label className="min-w-0 flex-1">
      <span className="label">{label}</span>
      <span className="relative block">
        <input
          className={cx('input !h-9 !pr-8 font-mono !text-[0.88rem]', invalid && '!border-danger')}
          inputMode="numeric"
          aria-invalid={invalid}
          value={text}
          onChange={(event) => {
            const next = event.target.value.replace(/[^\d]/g, '').slice(0, 5);
            setText(next);
            const n = Number(next);
            if (n >= MIN_EDGE && n <= MAX_EDGE) onCommit(n);
          }}
          onBlur={() => {
            const fixed = clampEdge(text) || value;
            setText(String(fixed));
            if (fixed !== value) onCommit(fixed);
          }}
        />
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[0.74rem] text-ink-3">px</span>
      </span>
    </label>
  );
}

interface SizePickerProps {
  value: SizeValue;
  onChange: (value: SizeValue) => void;
  /** Oran sekmesinde gösterilecek oranlar. */
  aspects?: string[];
  /** Yalnızca piksel boyutu anlamlıysa (tasarım, montaj) oran sekmesi gizlenir. */
  pixelsOnly?: boolean;
  /** Hazır boyutlardan hangi gruplar gösterilsin. */
  groups?: SizePreset['group'][];
  /** Özel boyut alanlarının altındaki açıklama; ölçünün nerede kullanılacağını söyler. */
  customHint?: string;
}

export function SizePicker({ value, onChange, aspects = ASPECTS.map((a) => a.id), pixelsOnly, groups = GROUPS, customHint }: SizePickerProps) {
  const exact = !!value.width && !!value.height;
  const presets = SIZE_PRESETS.filter((preset) => groups.includes(preset.group));
  const matched = exact ? presets.find((preset) => preset.width === value.width && preset.height === value.height) : undefined;
  const [tab, setTab] = useState<Tab>(exact ? (matched ? 'preset' : 'custom') : pixelsOnly ? 'preset' : 'ratio');

  const setSize = (width: number, height: number) => onChange({ aspect: ratioOf(width, height), width, height });
  const current = exact ? { width: value.width!, height: value.height! } : startingSize(value.aspect);

  const tabs: { value: Tab; label: string }[] = [
    ...(pixelsOnly ? [] : [{ value: 'ratio' as const, label: 'Oran' }]),
    { value: 'preset', label: 'Hazır boyut' },
    { value: 'custom', label: 'Özel' },
  ];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="label !mb-0">Boyut</span>
        <Segmented
          size="sm"
          value={tab}
          options={tabs}
          onChange={(next) => {
            setTab(next);
            // Özel sekmesi açılır açılmaz geçerli ölçüyü alanlara taşı ki doğrudan düzenlenebilsin.
            if (next === 'custom' && !exact) setSize(current.width, current.height);
          }}
        />
      </div>

      {tab === 'ratio' && (
        <div className="grid grid-cols-5 gap-1">
          {aspects.map((aspect) => {
            const active = !exact && aspect === value.aspect;
            return (
              <button
                key={aspect}
                type="button"
                aria-pressed={active}
                title={ASPECTS.find((a) => a.id === aspect)?.label}
                onClick={() => onChange({ aspect })}
                className={cx(
                  'flex h-[3.25rem] flex-col items-center justify-center gap-1 rounded-lg border text-[0.72rem] transition-colors',
                  active ? 'border-ink bg-ink text-bg' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink',
                )}
              >
                <span className="grid h-4 place-items-center">
                  <Glyph ratio={aspectToNumber(aspect)} />
                </span>
                <span className="font-mono">{aspect}</span>
              </button>
            );
          })}
        </div>
      )}

      {tab === 'preset' && (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-line p-1">
          {groups.map((group) => {
            const items = presets.filter((preset) => preset.group === group);
            if (!items.length) return null;
            return (
              <div key={group} role="group" aria-label={group}>
                <div className="px-2 pt-2 pb-1 text-[0.74rem] font-medium text-ink-3">{group}</div>
                {items.map((preset) => {
                  const active = matched?.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSize(preset.width, preset.height)}
                      className={cx(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.86rem] transition-colors',
                        active ? 'bg-ink text-bg' : 'text-ink hover:bg-sunken',
                      )}
                    >
                      <span className="grid w-4 flex-none place-items-center">
                        <Glyph ratio={preset.width / preset.height} box={14} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                      <span className={cx('font-mono text-[0.74rem]', active ? 'opacity-80' : 'text-ink-3')}>
                        {preset.width}×{preset.height}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'custom' && (
        <div>
          <div className="flex items-end gap-1.5">
            <EdgeInput label="Genişlik" value={current.width} onCommit={(width) => setSize(width, current.height)} />
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm mb-0.5 flex-none"
              aria-label="Genişlik ile yüksekliği değiştir"
              title="Yatay / dikey çevir"
              onClick={() => setSize(current.height, current.width)}
            >
              <ArrowLeftRight />
            </button>
            <EdgeInput label="Yükseklik" value={current.height} onCommit={(height) => setSize(current.width, height)} />
          </div>
          <p className="hint mt-2">
            {MIN_EDGE}–{MAX_EDGE} px arası. {customHint ?? 'Model en yakın oranda üretir; çıktı tam bu ölçüye getirilir.'}
          </p>
        </div>
      )}
    </div>
  );
}
