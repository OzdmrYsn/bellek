// @bahsetme kimlikleri. Türkçe karakterler ASCII'ye indirgenir; böylece
// "@Özge", "@ozge" ve "@ÖZGE" aynı kişiyi bulur.

const TR_MAP: Record<string, string> = {
  ı: 'i', İ: 'i', I: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g',
  ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c',
};

export function foldText(input: string): string {
  return input
    .replace(/[ıİIşŞğĞüÜöÖçÇ]/g, (ch) => TR_MAP[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function normalizeHandle(input: string): string {
  return foldText(input.replace(/^@/, ''))
    .replace(/[^a-z0-9_.-]+/g, '')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 32);
}

/** Bir addan aday kimlikler üretir: önce kısa olan, sonra tam ad. */
export function handleCandidates(name: string): string[] {
  const words = foldText(name)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return ['varlik'];
  const first = words[0];
  const joined = words.join('');
  const dotted = words.join('.');
  return [...new Set([first, joined, dotted])].map((h) => h.slice(0, 32));
}

const MENTION_RE = /(^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu;

export interface MentionToken {
  /** Metindeki ham parça, baştaki @ dahil. */
  raw: string;
  handle: string;
  start: number;
  end: number;
}

export function findMentions(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const lead = m[1] ?? '';
    // Cümle sonundaki nokta ve tire kimliğe dahil değildir.
    const token = m[2].replace(/[.-]+$/, '');
    const handle = normalizeHandle(token);
    if (!handle) continue;
    const start = (m.index ?? 0) + lead.length;
    out.push({ raw: `@${token}`, handle, start, end: start + token.length + 1 });
  }
  return out;
}
