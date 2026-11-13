import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MEMORY_CATEGORIES } from '../../shared/platforms.ts';
import type { MemoryCategory, MemorySuggestion } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { queryClient } from '../lib/queries.ts';
import { toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Spinner } from '../ui/kit.tsx';

const CATEGORY_LABEL = Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c.id, c.label])) as Record<MemoryCategory, string>;

interface SuggestionDialogProps {
  /** null iken kapalıdır. */
  suggestions: MemorySuggestion[] | null;
  onClose: () => void;
  title: string;
  description: string;
  /** Notların bağlanacağı varlık; yoksa genel hafızaya yazılır. */
  entityId?: string | null;
}

/**
 * Bellek'in çıkardığı dersler doğrudan hafızaya yazılmaz: önce burada gösterilir,
 * kullanıcı düzeltir ve yalnızca işaretlediklerini kaydeder.
 */
export function SuggestionDialog({ suggestions, onClose, title, description, entityId }: SuggestionDialogProps) {
  const [items, setItems] = useState<(MemorySuggestion & { on: boolean })[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (suggestions) setItems(suggestions.map((item) => ({ ...item, on: true })));
    setBusy(false);
  }, [suggestions]);

  const chosen = items.filter((item) => item.on && item.content.trim());

  const save = async () => {
    setBusy(true);
    let saved = 0;
    try {
      for (const item of chosen) {
        await api.post('/api/memories', { content: item.content.trim(), category: item.category, entityId: entityId ?? null });
        saved += 1;
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Notlar kaydedilemedi.', 'error');
    }
    setBusy(false);
    void queryClient.invalidateQueries({ queryKey: ['memories'] });
    if (saved) {
      toast(saved === 1 ? '1 not hafızaya eklendi.' : `${saved} not hafızaya eklendi.`, 'ok');
      onClose();
    }
  };

  return (
    <Dialog
      open={!!suggestions}
      onClose={onClose}
      size="lg"
      title={title}
      description={description}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-primary" disabled={busy || !chosen.length} onClick={save}>
            {busy && <Spinner />}
            {chosen.length ? `${chosen.length} notu hafızaya ekle` : 'Not seçin'}
          </button>
        </>
      }
    >
      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((item, index) => (
            <li key={index} className={cx('flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors', item.on ? 'border-line-strong bg-surface' : 'border-line opacity-60')}>
              <button
                type="button"
                role="checkbox"
                aria-checked={item.on}
                aria-label={item.on ? 'Bu notu ekleme' : 'Bu notu ekle'}
                onClick={() => setItems((list) => list.map((entry, i) => (i === index ? { ...entry, on: !entry.on } : entry)))}
                className={cx('mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-md border transition-colors', item.on ? 'border-ink bg-ink text-bg' : 'border-line-strong')}
              >
                {item.on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
              </button>
              <div className="min-w-0 flex-1">
                <textarea
                  className="block w-full resize-none bg-transparent text-[0.93rem] leading-relaxed outline-none [field-sizing:content]"
                  rows={2}
                  aria-label="Not metni"
                  value={item.content}
                  onChange={(event) => setItems((list) => list.map((entry, i) => (i === index ? { ...entry, content: event.target.value } : entry)))}
                />
                <span className="text-[0.78rem] text-ink-3">{CATEGORY_LABEL[item.category] ?? item.category}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-[0.93rem] text-ink-2">Bu kez kayda değer bir örüntü çıkmadı. Daha fazla veri birikince yeniden deneyin.</p>
      )}
    </Dialog>
  );
}
