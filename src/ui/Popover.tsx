import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/format.ts';

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

interface TriggerProps {
  ref: (node: HTMLElement | null) => void;
  onClick: (event: React.MouseEvent) => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'dialog';
}

interface PopoverProps {
  trigger: (props: TriggerProps, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: Placement;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Tetikleyiciye yapışan açılır yüzey. Gövdeye taşınır ve sabit konumlanır;
 * böylece kaydırılan ya da taşması gizlenen kapsayıcılar tarafından kırpılmaz.
 * İletişim kutularının (üst katman) içindeyken de görünsün diye en yakın
 * <dialog>'un içine yerleşir.
 */
export function Popover({ trigger, children, placement = 'bottom-start', className, onOpenChange }: PopoverProps) {
  const [open, setOpenState] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);

  const position = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const p = panel.current;
    if (!a || !p) return;
    const gap = 6;
    const margin = 8;
    const width = p.offsetWidth;
    const height = p.offsetHeight;
    let top = placement.startsWith('bottom') ? a.bottom + gap : a.top - height - gap;
    // Yer yoksa karşı tarafa çevir.
    if (placement.startsWith('bottom') && top + height > window.innerHeight - margin && a.top - height - gap > margin) {
      top = a.top - height - gap;
    } else if (placement.startsWith('top') && top < margin) {
      top = a.bottom + gap;
    }
    let left = placement.endsWith('start') ? a.left : a.right - width;
    left = Math.min(window.innerWidth - width - margin, Math.max(margin, left));
    top = Math.min(window.innerHeight - height - margin, Math.max(margin, top));
    setStyle({ top, left, visibility: 'visible' });
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    setStyle({ visibility: 'hidden' });
    position();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        anchor.current?.focus();
      }
    };
    const onMove = () => position();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    const observer = new ResizeObserver(onMove);
    if (panel.current) observer.observe(panel.current);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      observer.disconnect();
    };
  }, [open, close, position]);

  const host = (open && anchor.current?.closest('dialog')) || document.body;

  return (
    <>
      {trigger(
        {
          ref: (node) => {
            anchor.current = node;
          },
          onClick: (event) => {
            event.stopPropagation();
            setOpen(!open);
          },
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
        },
        open,
      )}
      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            style={{ position: 'fixed', zIndex: 'var(--z-dropdown)', ...style }}
            className={cx('pop animate-rise origin-top p-1.5', className)}
            onClick={(event) => event.stopPropagation()}
          >
            {children(close)}
          </div>,
          host,
        )}
    </>
  );
}

export interface MenuEntry {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

interface MenuProps {
  trigger: PopoverProps['trigger'];
  items: (MenuEntry | 'divider')[];
  placement?: Placement;
}

export function Menu({ trigger, items, placement = 'bottom-end' }: MenuProps) {
  return (
    <Popover trigger={trigger} placement={placement} className="min-w-44">
      {(close) => (
        <div role="menu">
          {items.map((item, index) =>
            item === 'divider' ? (
              <div key={`d${index}`} className="my-1 border-t border-line" />
            ) : item.hidden ? null : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="menu-item"
                data-danger={item.danger || undefined}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </Popover>
  );
}
