import { Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { foldText } from '../../shared/handles.ts';
import { ENTITY_TYPES, entityTypeLabel } from '../../shared/platforms.ts';
import type { Entity, EntityAssetRole, EntityType } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { queryClient, refreshApp, useEntities } from '../lib/queries.ts';
import { attempt, toast } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Avatar, Empty, Segmented, Spinner } from '../ui/kit.tsx';

interface EntityPickerDialogProps {
  open: boolean;
  onClose: () => void;
  assetIds: string[];
  /** Açılışta "yeni oluştur" formunu göster. */
  startNew?: boolean;
  onDone?: (entity: Entity) => void;
}

/** Seçili görselleri bir kişiye, markaya ya da başka bir varlığa referans olarak bağlar. */
export function EntityPickerDialog({ open, onClose, assetIds, startNew, onDone }: EntityPickerDialogProps) {
  const entities = useEntities();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<EntityType>('person');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery('');
      setName('');
      setType('person');
      setCreating(!!startNew || entities.length === 0);
    }
    // Yalnızca açılışta sıfırlanır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    const needle = foldText(query.trim());
    return needle ? entities.filter((e) => foldText(e.name).includes(needle) || e.handle.includes(needle.replace(/^@/, ''))) : entities;
  }, [entities, query]);

  const finish = (entity: Entity, verb: string) => {
    void queryClient.invalidateQueries({ queryKey: ['entity', entity.id] });
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    void refreshApp();
    toast(`${assetIds.length > 1 ? `${assetIds.length} görsel` : 'Görsel'} @${entity.handle} ${verb}.`, 'ok', {
      label: 'Aç',
      run: () => navigate(`/hafiza/${entity.id}`),
    });
    onDone?.(entity);
    onClose();
  };

  const link = async (entity: Entity, role: EntityAssetRole = 'reference') => {
    setBusy(true);
    const done = await attempt(() => api.post(`/api/entities/${entity.id}/assets`, { assetIds, role }));
    setBusy(false);
    if (done) finish(entity, 'referanslarına eklendi');
  };

  const create = async () => {
    setBusy(true);
    const entity = await attempt(() =>
      api.post<Entity>('/api/entities', { type, name, assetIds, role: type === 'brand' ? 'logo' : 'reference' }),
    );
    setBusy(false);
    if (entity) finish(entity, 'olarak kaydedildi');
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={creating ? 'Yeni varlık oluştur' : 'Referans olarak ekle'}
      description={
        creating
          ? `${assetIds.length} görsel bu varlığın referansı olacak. Sohbette @ ile çağırabilirsiniz.`
          : 'Görsel hangi kişi, marka ya da ürünün referansı olsun?'
      }
      footer={
        creating ? (
          <>
            {entities.length > 0 && (
              <button type="button" className="btn btn-ghost mr-auto" onClick={() => setCreating(false)}>
                Var olana ekle
              </button>
            )}
            <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
            <button type="button" className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
              {busy && <Spinner />} Oluştur
            </button>
          </>
        ) : undefined
      }
    >
      {creating ? (
        <div className="flex flex-col gap-4">
          <Segmented
            value={type}
            onChange={setType}
            size="sm"
            className="self-start"
            options={ENTITY_TYPES.map((t) => ({ value: t.id, label: t.label, title: t.hint }))}
          />
          <label className="block">
            <span className="label">Ad</span>
            <input
              autoFocus
              className="input"
              placeholder={type === 'person' ? 'Örn. Yasin Özdemir' : type === 'brand' ? 'Örn. Acme Kahve' : 'Ad'}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && name.trim() && void create()}
            />
          </label>
          <p className="hint">{ENTITY_TYPES.find((t) => t.id === type)?.hint}.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <input
              autoFocus
              className="input !pl-9"
              placeholder="Ad ya da @kimlik ara"
              aria-label="Varlık ara"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="-mx-1.5 max-h-72 overflow-y-auto">
            <button type="button" className="menu-item" onClick={() => setCreating(true)}>
              <span className="grid h-8 w-8 place-items-center rounded-full bg-sunken">
                <Plus />
              </span>
              <span className="font-medium">Yeni kişi, marka ya da ürün oluştur</span>
            </button>
            {filtered.map((entity) => (
              <div key={entity.id} className="menu-item !cursor-default">
                <Avatar entity={entity} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{entity.name}</span>
                  <span className="meta">@{entity.handle} · {entityTypeLabel(entity.type)}</span>
                </span>
                {entity.type === 'brand' ? (
                  <>
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void link(entity, 'logo')}>Logo</button>
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void link(entity, 'example')}>Örnek</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void link(entity)}>Ekle</button>
                )}
              </div>
            ))}
            {!filtered.length && query && <Empty className="!py-8" title="Eşleşen varlık yok" body="Yeni bir tane oluşturabilirsiniz." />}
          </div>
        </div>
      )}
    </Dialog>
  );
}
