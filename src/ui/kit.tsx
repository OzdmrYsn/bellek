import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { getPlatform } from '../../shared/platforms.ts';
import type { Entity, EntityType } from '../../shared/types.ts';
import { cx } from '../lib/format.ts';
import { useUI } from '../lib/store.ts';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="flex-none">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="var(--accent)" strokeWidth="3" />
      <circle cx="16" cy="16" r="2.6" fill="var(--bg)" />
    </svg>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'outline';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx('btn btn-icon', variant === 'ghost' ? 'btn-ghost' : 'btn-outline', size === 'sm' && 'btn-sm', className)}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-label="Yükleniyor" className={cx('spinner', className)} />;
}

export function PageLoader() {
  return (
    <div className="grid h-full place-items-center text-ink-3">
      <Spinner className="!h-5 !w-5" />
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode; title?: string }[];
  size?: 'sm' | 'md';
  className?: string;
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', className }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" className={cx('inline-flex rounded-[9px] bg-sunken p-[3px]', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-[7px] font-medium whitespace-nowrap transition-colors duration-150',
              size === 'sm' ? 'h-7 px-2.5 text-[0.82rem]' : 'h-8 px-3 text-[0.88rem]',
              active ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink',
            )}
          >
            {option.icon && <span className="[&>svg]:h-[15px] [&>svg]:w-[15px]">{option.icon}</span>}
            <span data-label>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-[22px] w-[38px] flex-none rounded-full transition-colors duration-200 disabled:opacity-50',
        checked ? 'bg-ink' : 'bg-line-strong',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-bg transition-transform duration-200 ease-out',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}

export function Field({ label, hint, error, children, className }: { label?: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      {label && <span className="label">{label}</span>}
      {children}
      {error ? <span className="mt-1 block text-[0.82rem] text-danger">{error}</span> : hint ? <span className="hint mt-1 block">{hint}</span> : null}
    </label>
  );
}

/** Ayar satırı: solda açıklama, sağda denetim. */
export function SettingRow({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-4">
      <div className="max-w-[34rem] min-w-[14rem] flex-1">
        <div className="text-[0.95rem] font-medium">{title}</div>
        {description && <div className="hint mt-0.5">{description}</div>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

const TYPE_SHAPE: Record<EntityType, string> = {
  person: 'rounded-full',
  brand: 'rounded-[28%]',
  product: 'rounded-[22%]',
  style: 'rounded-[22%]',
  place: 'rounded-[22%]',
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')).toLocaleUpperCase('tr');
}

export function Avatar({ entity, size = 28, className }: { entity: Pick<Entity, 'name' | 'type' | 'avatarUrl'>; size?: number; className?: string }) {
  const shape = TYPE_SHAPE[entity.type];
  if (entity.avatarUrl) {
    return (
      <img
        src={entity.avatarUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        style={{ width: size, height: size }}
        className={cx('flex-none bg-sunken object-cover', shape, className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
      className={cx('grid flex-none place-items-center bg-sunken font-semibold text-ink-2 ring-1 ring-line ring-inset', shape, className)}
    >
      {initials(entity.name)}
    </span>
  );
}

export function MentionTag({ handle }: { handle: string }) {
  return <span className="mention">@{handle}</span>;
}

export function PlatformBadge({ platform, className }: { platform: string; className?: string }) {
  const info = getPlatform(platform);
  return (
    <span className={cx('badge', className)} title={info.label}>
      {info.short}
    </span>
  );
}

export function Empty({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('mx-auto flex max-w-md flex-col items-center px-6 py-14 text-center', className)}>
      {icon && <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-sunken text-ink-2 [&>svg]:h-6 [&>svg]:w-6">{icon}</div>}
      <h3 className="text-[1.05rem] font-semibold">{title}</h3>
      {body && <p className="mt-1.5 text-[0.93rem] leading-relaxed text-ink-2">{body}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Notice({ level = 'info', children, action }: { level?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const tone = {
    info: 'bg-sunken text-ink-2',
    warn: 'bg-warn-soft text-warn',
    error: 'bg-danger-soft text-danger',
    ok: 'bg-ok-soft text-ok',
  }[level];
  const Icon = level === 'info' ? Info : level === 'ok' ? Check : AlertTriangle;
  return (
    <div className={cx('flex items-start gap-2.5 rounded-[10px] px-3.5 py-2.5 text-[0.9rem] leading-snug', tone)}>
      <Icon className="mt-[1px] h-[17px] w-[17px] flex-none" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex-none border-b border-line bg-bg px-6 pt-5 pb-0 max-md:px-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4">
        <div className="min-w-0">
          <h1 className="text-[1.45rem] leading-tight font-semibold">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[0.93rem] text-ink-2">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function TabBar<T extends string>({ value, onChange, tabs }: { value: T; onChange: (value: T) => void; tabs: { value: T; label: string; count?: number }[] }) {
  return (
    <div role="tablist" className="-mb-px flex gap-5 overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            className={cx(
              'flex items-center gap-1.5 border-b-2 pb-2.5 text-[0.93rem] font-medium whitespace-nowrap transition-colors',
              active ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink',
            )}
          >
            {tab.label}
            {tab.count !== undefined && <span className="meta">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Toasts() {
  const toasts = useUI((state) => state.toasts);
  const dismiss = useUI((state) => state.dismissToast);
  const ref = useRef<HTMLDivElement>(null);

  // Açık bir iletişim kutusu tarayıcının "üst katmanında" durur; bildirimlerin
  // onun da üstünde görünmesi için aynı katmana, en sona yeniden eklenirler.
  useEffect(() => {
    const node = ref.current;
    if (!node?.showPopover) return;
    try {
      if (node.matches(':popover-open')) node.hidePopover();
      if (toasts.length) node.showPopover();
    } catch {
      // Popover API yoksa sabit konumlu kutu yine görünür.
    }
  }, [toasts]);

  return (
    <div
      ref={ref}
      popover="manual"
      aria-live="polite"
      className="pointer-events-none fixed inset-auto bottom-5 left-1/2 m-0 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 overflow-visible border-0 bg-transparent p-0 [&:popover-open]:flex"
      style={{ zIndex: 'var(--z-toast)' }}
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          className="pop pointer-events-auto flex animate-rise items-start gap-3 py-2.5 pr-2 pl-3.5 text-[0.9rem]"
        >
          <span
            className={cx(
              'mt-[3px] h-2 w-2 flex-none rounded-full',
              item.kind === 'error' ? 'bg-danger' : item.kind === 'ok' ? 'bg-ok' : 'bg-ink-3',
            )}
          />
          <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">{item.text}</span>
          {item.action && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                item.action!.run();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => dismiss(item.id)} aria-label="Kapat">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
