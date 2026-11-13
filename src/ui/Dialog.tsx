import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../lib/format.ts';
import { useUI } from '../lib/store.ts';

const SIZES = {
  sm: 'w-[min(26rem,calc(100vw-2rem))]',
  md: 'w-[min(34rem,calc(100vw-2rem))]',
  lg: 'w-[min(46rem,calc(100vw-2rem))]',
  xl: 'w-[min(68rem,calc(100vw-2rem))]',
};

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** İçerik kendi düzenini kurar: başlık ve iç boşluk eklenmez. */
  bare?: boolean;
  className?: string;
  children: ReactNode;
}

export function Dialog({ open, onClose, title, description, footer, size = 'md', bare, className, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cx(
        'pop m-auto animate-rise overflow-hidden bg-surface p-0 backdrop:bg-black/45',
        !bare && SIZES[size],
        className,
      )}
    >
      {bare ? (
        children
      ) : (
        <div className="flex max-h-[min(86dvh,52rem)] flex-col">
          {(title || description) && (
            <header className="flex items-start gap-4 px-5 pt-5 pb-1">
              <div className="min-w-0 flex-1">
                {title && <h2 className="text-[1.08rem] font-semibold">{title}</h2>}
                {description && <p className="mt-1 text-[0.9rem] text-ink-2">{description}</p>}
              </div>
              <button type="button" className="btn btn-ghost btn-icon btn-sm -mt-1 -mr-1.5" onClick={onClose} aria-label="Kapat">
                <X />
              </button>
            </header>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-bg px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/** Uygulama genelindeki tek onay penceresi; `confirmDialog()` ile açılır. */
export function ConfirmHost() {
  const request = useUI((state) => state.confirmRequest);
  const settle = useUI((state) => state.settleConfirm);
  return (
    <Dialog
      open={!!request}
      onClose={() => settle(false)}
      size="sm"
      title={request?.title}
      description={request?.body}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={() => settle(false)}>
            Vazgeç
          </button>
          <button type="button" autoFocus className={cx('btn', request?.danger ? 'btn-danger' : 'btn-primary')} onClick={() => settle(true)}>
            {request?.confirm}
          </button>
        </>
      }
    >
      <span />
    </Dialog>
  );
}
