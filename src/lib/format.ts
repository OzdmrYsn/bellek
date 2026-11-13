const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
export const MONTHS_LONG = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];
export const WEEKDAYS_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'az önce';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} dk önce`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} sa önce`;
  if (seconds < 172800) return 'dün';
  if (seconds < 604800) return `${Math.round(seconds / 86400)} gün önce`;
  return shortDate(iso);
}

export function shortDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${sameYear ? '' : ` ${date.getFullYear()}`}`;
}

export function dateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shortDate(iso)}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** <input type="datetime-local"> için yerel saatle "YYYY-MM-DDTHH:mm". */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

export function duration(seconds: number | null): string {
  if (!seconds) return '';
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded} sn` : `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

export function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} B`;
  return `${(value / 1_000_000).toFixed(1)} Mn`;
}

/** ABD doları; küçük tutarlarda kuruş altı da görünür. */
export function usd(value: number): string {
  const digits = value !== 0 && Math.abs(value) < 1 ? 3 : 2;
  return `${value.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: digits })} $`;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
