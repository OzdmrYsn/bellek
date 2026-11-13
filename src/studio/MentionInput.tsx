import { UserPlus } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { findMentions, foldText } from '../../shared/handles.ts';
import { entityTypeLabel } from '../../shared/platforms.ts';
import type { Entity } from '../../shared/types.ts';
import { cx } from '../lib/format.ts';
import { Avatar } from '../ui/kit.tsx';

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  entities: Entity[];
  placeholder?: string;
  maxHeight?: number;
  minHeight?: number;
  autoFocus?: boolean;
  onFiles?: (files: File[]) => void;
  className?: string;
  ariaLabel: string;
  /** Öneri listesi alanın üstünde mi altında mı açılsın. */
  menuSide?: 'top' | 'bottom';
}

export interface MentionInputHandle {
  focus: () => void;
  insert: (text: string) => void;
}

interface Token {
  start: number;
  query: string;
}

function tokenAt(text: string, caret: number): Token | null {
  const match = text.slice(0, caret).match(/(^|[\s(,;:])@([\p{L}\p{N}_.-]*)$/u);
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

/**
 * @bahsetme destekli metin alanı. Düz bir <textarea> kullanılır (yapıştırma,
 * geri alma, IME kusursuz çalışır); tanınan kimlikler arkadaki aynalı katmanda
 * vurgulanır.
 */
export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(function MentionInput(
  { value, onChange, onSubmit, entities, placeholder, maxHeight = 260, minHeight = 52, autoFocus, onFiles, className, ariaLabel, menuSide = 'top' },
  ref,
) {
  const navigate = useNavigate();
  const area = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [index, setIndex] = useState(0);
  const pendingCaret = useRef<number | null>(null);

  const byHandle = useMemo(() => new Map(entities.map((e) => [e.handle, e])), [entities]);

  const segments = useMemo(() => {
    const out: { text: string; known: boolean }[] = [];
    let cursor = 0;
    for (const mention of findMentions(value)) {
      if (!byHandle.has(mention.handle)) continue;
      if (mention.start > cursor) out.push({ text: value.slice(cursor, mention.start), known: false });
      out.push({ text: value.slice(mention.start, mention.end), known: true });
      cursor = mention.end;
    }
    out.push({ text: value.slice(cursor), known: false });
    return out;
  }, [value, byHandle]);

  const matches = useMemo(() => {
    if (!token) return [];
    const needle = foldText(token.query);
    const scored = entities
      .map((entity) => {
        const name = foldText(entity.name);
        const rank = !needle ? 2 : entity.handle.startsWith(needle) ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) || entity.handle.includes(needle) ? 2 : -1;
        return { entity, rank };
      })
      .filter((item) => item.rank >= 0)
      .sort((a, b) => a.rank - b.rank || Number(b.entity.pinned) - Number(a.entity.pinned) || b.entity.updatedAt.localeCompare(a.entity.updatedAt));
    return scored.slice(0, 7).map((item) => item.entity);
  }, [token, entities]);

  useEffect(() => setIndex(0), [token?.query]);

  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(maxHeight, Math.max(minHeight, node.scrollHeight))}px`;
    if (mirror.current) mirror.current.scrollTop = node.scrollTop;
    if (pendingCaret.current !== null) {
      node.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value, maxHeight, minHeight]);

  const refreshToken = () => {
    const node = area.current;
    if (!node || node.selectionStart !== node.selectionEnd) return setToken(null);
    setToken(tokenAt(node.value, node.selectionStart));
  };

  const insertAt = (start: number, end: number, text: string) => {
    onChange(value.slice(0, start) + text + value.slice(end));
    pendingCaret.current = start + text.length;
    area.current?.focus();
  };

  const choose = (entity: Entity) => {
    if (!token || !area.current) return;
    insertAt(token.start, area.current.selectionStart, `@${entity.handle} `);
    setToken(null);
  };

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    insert: (text: string) => {
      const node = area.current;
      const at = node ? node.selectionStart : value.length;
      const lead = at > 0 && !/\s$/.test(value.slice(0, at)) ? ' ' : '';
      insertAt(at, node ? node.selectionEnd : at, lead + text);
      window.requestAnimationFrame(refreshToken);
    },
  }));

  const menuOpen = !!token && (matches.length > 0 || token.query.length > 0);

  return (
    <div
      className={cx('relative cursor-text', className)}
      onMouseDown={(event) => {
        // İç boşluğa tıklamak da alanı odaklar.
        if (event.target === event.currentTarget) {
          event.preventDefault();
          area.current?.focus();
        }
      }}
    >
      <div
        ref={mirror}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap text-transparent"
        style={{ font: 'inherit', padding: 'inherit' }}
      >
        {segments.map((segment, i) =>
          segment.known ? (
            <mark key={i} className="rounded-[5px] bg-accent-soft text-transparent shadow-[0_0_0_2px_var(--accent-soft)]">
              {segment.text}
            </mark>
          ) : (
            <span key={i}>{segment.text}</span>
          ),
        )}
        {'\n'}
      </div>
      <textarea
        ref={area}
        value={value}
        rows={1}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={false}
        className="relative block w-full resize-none bg-transparent p-0 outline-none"
        style={{ font: 'inherit', minHeight, maxHeight }}
        onChange={(event) => {
          onChange(event.target.value);
          setToken(tokenAt(event.target.value, event.target.selectionStart));
        }}
        onSelect={refreshToken}
        onBlur={() => window.setTimeout(() => setToken(null), 120)}
        onScroll={(event) => {
          if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
          if (files.length && onFiles) {
            event.preventDefault();
            onFiles(files);
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (menuOpen && matches.length) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              return setIndex((i) => (i + 1) % matches.length);
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              return setIndex((i) => (i - 1 + matches.length) % matches.length);
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              return choose(matches[index]);
            }
          }
          if (menuOpen && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            return setToken(null);
          }
          if (event.key === 'Enter' && !event.shiftKey && onSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />

      {menuOpen && (
        <div
          role="listbox"
          aria-label="Hafızadaki varlıklar"
          className={cx(
            'pop absolute left-0 w-[min(22rem,100%)] animate-rise p-1.5',
            menuSide === 'top' ? 'bottom-[calc(100%+0.6rem)] origin-bottom' : 'top-[calc(100%+0.4rem)] origin-top',
          )}
          style={{ zIndex: 'var(--z-dropdown)' }}
        >
          {matches.map((entity, i) => (
            <button
              key={entity.id}
              type="button"
              role="option"
              aria-selected={i === index}
              data-active={i === index}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(entity)}
              className="menu-item"
            >
              <Avatar entity={entity} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entity.name}</span>
                <span className="meta">@{entity.handle}</span>
              </span>
              <span className="text-[0.76rem] text-ink-3">
                {entityTypeLabel(entity.type)}
                {entity.assetCount ? ` · ${entity.assetCount} görsel` : ''}
              </span>
            </button>
          ))}
          {!matches.length && token && (
            <button
              type="button"
              className="menu-item"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => navigate(`/hafiza?yeni=person&ad=${encodeURIComponent(token.query)}`)}
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-sunken">
                <UserPlus />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">“{token.query}” hafızada yok</span>
                <span className="text-[0.8rem] text-ink-3">Kişi ya da marka olarak ekle</span>
              </span>
            </button>
          )}
          {matches.length > 0 && (
            <p className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[0.74rem] text-ink-3">
              <span className="kbd">↑↓</span> seç <span className="kbd">↵</span> ekle
            </p>
          )}
        </div>
      )}
    </div>
  );
});
