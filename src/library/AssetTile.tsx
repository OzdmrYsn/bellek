import {
  Check, Clapperboard, Download, Heart, LayoutTemplate, MoreHorizontal, Newspaper, Pencil, Play, Trash2, UserPlus, ScanFace,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Asset } from '../../shared/types.ts';
import { cx, duration } from '../lib/format.ts';
import { useUI } from '../lib/store.ts';
import { Menu } from '../ui/Popover.tsx';
import { downloadAsset, ratioStyle, toggleFavorite, trashAssets, useAssetActions } from './actions.ts';
import { EntityPickerDialog } from './EntityPicker.tsx';

interface AssetTileProps {
  asset: Asset;
  onOpen?: () => void;
  /** Kare kırpılmış ızgara karosu yerine görselin kendi oranını kullan. */
  natural?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (shiftKey: boolean) => void;
  /** Üretimden yeni çıkan görsel banyodaymış gibi belirir. */
  develop?: boolean;
  actions?: boolean;
  caption?: ReactNode;
  className?: string;
}

function TileButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cx(
        'grid h-7 w-7 place-items-center rounded-md text-white/90 transition-colors hover:bg-white/20 hover:text-white [&>svg]:h-[15px] [&>svg]:w-[15px]',
        active && 'text-accent',
      )}
    >
      {children}
    </button>
  );
}

export function AssetTile({ asset, onOpen, natural, selectable, selected, onSelect, develop, actions = true, caption, className }: AssetTileProps) {
  const act = useAssetActions();
  const [picking, setPicking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isVideo = asset.kind === 'video';

  return (
    <figure
      className={cx(
        'group relative overflow-hidden rounded-[10px] bg-sunken',
        selected && 'ring-[3px] ring-accent ring-offset-2 ring-offset-bg',
        className,
      )}
      style={natural ? ratioStyle(asset) : { aspectRatio: '1' }}
    >
      <button
        type="button"
        onClick={(event) => {
          if (selectable && (selected || event.shiftKey || event.metaKey || event.ctrlKey)) onSelect?.(event.shiftKey);
          else onOpen?.();
        }}
        className="block h-full w-full cursor-zoom-in"
        aria-label={asset.title ?? asset.prompt ?? asset.filename}
      >
        {asset.thumbUrl ? (
          <img
            src={asset.thumbUrl}
            alt={asset.title ?? asset.prompt ?? ''}
            loading="lazy"
            draggable={false}
            className={cx('h-full w-full object-cover', develop && 'developed')}
          />
        ) : (
          <video src={asset.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        )}
      </button>

      {isVideo && (
        <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[0.7rem] text-white">
          <Play className="h-3 w-3 fill-current" />
          {duration(asset.duration)}
        </span>
      )}

      {selectable && (
        <button
          type="button"
          aria-label={selected ? 'Seçimi kaldır' : 'Seç'}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect?.(event.shiftKey);
          }}
          className={cx(
            'absolute top-2 right-2 grid h-6 w-6 place-items-center rounded-full border-2 transition-all duration-150',
            selected
              ? 'border-accent bg-accent text-on-accent'
              : 'border-white/90 bg-black/25 text-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </button>
      )}

      {asset.favorite && !selectable && (
        <Heart className="pointer-events-none absolute top-2 right-2 h-4 w-4 fill-accent text-accent drop-shadow" />
      )}

      {actions && (
        <div
          className={cx(
            'absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-6 pb-1.5 transition-opacity duration-150',
            menuOpen ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <TileButton label={asset.favorite ? 'Favorilerden çıkar' : 'Favorilere ekle'} active={asset.favorite} onClick={() => void toggleFavorite(asset)}>
            <Heart className={cx(asset.favorite && 'fill-current')} />
          </TileButton>
          {!isVideo && (
            <>
              <TileButton label="Bunu düzenle" onClick={() => act.edit(asset)}>
                <Pencil />
              </TileButton>
              <TileButton label="Videoya çevir" onClick={() => act.animate(asset)}>
                <Clapperboard />
              </TileButton>
            </>
          )}
          <span className="flex-1" />
          <TileButton label="İndir" onClick={() => downloadAsset(asset)}>
            <Download />
          </TileButton>
          <Menu
            placement="top-end"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                aria-label="Diğer eylemler"
                className="grid h-7 w-7 place-items-center rounded-md text-white/90 hover:bg-white/20 hover:text-white"
                onClick={(event) => {
                  props.onClick(event);
                  setMenuOpen(true);
                }}
                onBlur={() => setMenuOpen(false)}
              >
                <MoreHorizontal className="h-[15px] w-[15px]" />
              </button>
            )}
            items={[
              { label: 'Kişileri seç…', icon: <ScanFace />, onSelect: () => useUI.getState().openPeople(asset), hidden: isVideo },
              { label: 'Referans olarak ekle…', icon: <UserPlus />, onSelect: () => setPicking(true), hidden: isVideo },
              { label: 'Gönderi oluştur', icon: <Newspaper />, onSelect: () => void act.toPost(asset) },
              { label: 'Tasarım editöründe aç', icon: <LayoutTemplate />, onSelect: () => void act.toDesign(asset), hidden: isVideo },
              'divider',
              { label: 'Çöp kutusuna taşı', icon: <Trash2 />, danger: true, onSelect: () => void trashAssets([asset.id]) },
            ]}
          />
        </div>
      )}
      {caption}
      <EntityPickerDialog open={picking} onClose={() => setPicking(false)} assetIds={[asset.id]} />
    </figure>
  );
}
