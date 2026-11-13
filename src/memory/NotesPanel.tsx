import { Heart, Pin, PinOff, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { MEMORY_CATEGORIES } from '../../shared/platforms.ts';
import type { Memory, MemoryCategory, MemorySuggestion } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx, timeAgo } from '../lib/format.ts';
import { useApp, useEntities, useMemories } from '../lib/queries.ts';
import { attempt, toast } from '../lib/store.ts';
import { Empty, IconButton, Spinner, Switch } from '../ui/kit.tsx';
import { SuggestionDialog } from './SuggestionDialog.tsx';

const CATEGORY_LABEL = Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c.id, c.label])) as Record<MemoryCategory, string>;

function NoteRow({ note, showEntity }: { note: Memory; showEntity: boolean }) {
  const entities = useEntities();
  const [text, setText] = useState(note.content);
  const [editing, setEditing] = useState(false);
  const entity = note.entityId ? entities.find((e) => e.id === note.entityId) : null;

  const save = async () => {
    setEditing(false);
    if (text.trim() && text.trim() !== note.content) await attempt(() => api.patch(`/api/memories/${note.id}`, { content: text }));
    else setText(note.content);
  };

  return (
    <li className={cx('group flex items-start gap-3 border-b border-line py-3 last:border-0', !note.enabled && 'opacity-55')}>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            autoFocus
            className="input"
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void save();
              }
            }}
          />
        ) : (
          <button type="button" className="block w-full text-left text-[0.95rem] leading-relaxed [overflow-wrap:anywhere]" onClick={() => setEditing(true)} title="Düzenlemek için tıklayın">
            {note.content}
          </button>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.78rem] text-ink-3">
          <span>{CATEGORY_LABEL[note.category]}</span>
          {showEntity && entity && (
            <Link to={`/hafiza/${entity.id}`} className="mention !text-[0.76rem]">
              @{entity.handle}
            </Link>
          )}
          {note.source === 'auto' && (
            <span className="inline-flex items-center gap-1" title="Sohbetten otomatik çıkarıldı">
              <Sparkles className="h-3 w-3" /> sohbetten
            </span>
          )}
          <span>{timeAgo(note.createdAt)}</span>
        </div>
      </div>
      <div className="flex flex-none items-center gap-1">
        <IconButton
          label={note.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle (her zaman önce okunur)'}
          size="sm"
          className={cx(!note.pinned && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
          onClick={() => void attempt(() => api.patch(`/api/memories/${note.id}`, { pinned: !note.pinned }))}
        >
          {note.pinned ? <Pin className="text-accent-text" /> : <PinOff />}
        </IconButton>
        <IconButton
          label="Unut"
          size="sm"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={async () => {
            const ok = await attempt(() => api.del(`/api/memories/${note.id}`));
            if (ok) {
              toast('Not çöp kutusuna taşındı.', 'info', {
                label: 'Geri al',
                run: () => void api.post('/api/trash/restore', { kind: 'memory', id: note.id }),
              });
            }
          }}
        >
          <Trash2 />
        </IconButton>
        <Switch
          checked={note.enabled}
          label={note.enabled ? 'Kullanımda' : 'Devre dışı'}
          onChange={(enabled) => void attempt(() => api.patch(`/api/memories/${note.id}`, { enabled }))}
        />
      </div>
    </li>
  );
}

interface NotesPanelProps {
  /** Verilirse yalnızca bu varlığa ait notlar gösterilir ve yeni notlar ona bağlanır. */
  entityId?: string;
  placeholder?: string;
}

export function NotesPanel({ entityId, placeholder }: NotesPanelProps) {
  const notes = useMemories(entityId);
  const [text, setText] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('preference');
  const [busy, setBusy] = useState(false);
  const [learning, setLearning] = useState(false);
  const [suggestions, setSuggestions] = useState<MemorySuggestion[] | null>(null);
  const app = useApp();
  const canLearn = app.models.some((m) => m.model.kind === 'text' && m.model.vision !== false);

  const learn = async () => {
    setLearning(true);
    const found = await attempt(() => api.post<MemorySuggestion[]>('/api/memories/learn'));
    setLearning(false);
    if (found) setSuggestions(found);
  };

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const created = await attempt(() => api.post('/api/memories', { content: text, category, entityId: entityId ?? null }));
    setBusy(false);
    if (created) setText('');
  };

  return (
    <div>
      <div className="flex flex-wrap items-start gap-2">
        <textarea
          className="input min-w-56 flex-1"
          rows={1}
          placeholder={placeholder ?? 'Bellek neyi hatırlasın? Örn. “Başlıklarda asla ünlem kullanma.”'}
          aria-label="Yeni not"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void add();
            }
          }}
        />
        <select className="input !w-auto" value={category} onChange={(event) => setCategory(event.target.value as MemoryCategory)} aria-label="Not türü">
          {MEMORY_CATEGORIES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" disabled={!text.trim() || busy} onClick={add}>
          {busy ? <Spinner /> : <Plus />} Ekle
        </button>
      </div>

      {!entityId && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl bg-sunken px-3.5 py-2.5">
          <p className="min-w-[14rem] flex-1 text-[0.88rem] text-ink-2">
            Kütüphanede kalp verdiğiniz görsellere bakıp zevkinizi not çıkarabilir: ışık, renk, kadraj, üslup.
          </p>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={learning || !canLearn}
            title={canLearn ? undefined : 'Görsel okuyabilen bir metin modeli bağlayın'}
            onClick={learn}
          >
            {learning ? <Spinner /> : <Heart />} {learning ? 'Favorilere bakılıyor…' : 'Favorilerden öğren'}
          </button>
        </div>
      )}

      {notes.isLoading ? (
        <div className="grid h-24 place-items-center text-ink-3"><Spinner /></div>
      ) : notes.data?.length ? (
        <ul className="mt-3">
          {notes.data.map((note) => (
            <NoteRow key={note.id} note={note} showEntity={!entityId} />
          ))}
        </ul>
      ) : (
        <Empty
          className="!py-10"
          title={entityId ? 'Henüz not yok' : 'Hafızada not yok'}
          body={
            entityId
              ? 'Buraya eklediğiniz her not, bu varlık anıldığında modele iletilir.'
              : 'Kuralları ve tercihleri buraya yazın ya da sohbette “bundan sonra…” deyin; Bellek kendisi not alır.'
          }
        />
      )}
      <SuggestionDialog
        suggestions={suggestions}
        onClose={() => setSuggestions(null)}
        title="Favorilerinizden çıkan zevk notları"
        description="Kalp verdiğiniz görsellerdeki ortak noktalar. İşaretledikleriniz hafızaya eklenir ve sonraki üretimlerde gözetilir."
      />
    </div>
  );
}
