// Model, yanıtının içine eylem blokları yazar; uygulama bunları çalıştırır:
//
//   <generate_image aspect="4:5" refs="@yasin">…istem…</generate_image>
//
// Yerel araç çağrısı yerine metin içi bloklar kullanılır çünkü bu biçim her
// sağlayıcıda (yerel modeller dahil) aynı şekilde çalışır ve akışla birlikte
// ilerler: blok kapandığı anda üretim başlar, metnin geri kalanı yazılmaya devam eder.

export const ACTION_TAGS = ['generate_image', 'generate_video', 'post', 'remember'] as const;
export type ActionTag = (typeof ACTION_TAGS)[number];

export interface ParsedAction {
  tag: ActionTag;
  attrs: Record<string, string>;
  body: string;
}

const OPEN_RE = new RegExp(`^<(${ACTION_TAGS.join('|')})(\\s[^>]*)?>`);

export function parseAttrs(source: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!source) return attrs;
  for (const match of source.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? '').trim();
  }
  return attrs;
}

/** Henüz tamamlanmamış bir parça, ileride bir eylem etiketine dönüşebilir mi. */
function mayBecomeTag(fragment: string): boolean {
  if (fragment.length > 600 || fragment.includes('>')) return false;
  return ACTION_TAGS.some((tag) => {
    const open = `<${tag}`;
    if (fragment.length <= open.length) return open.startsWith(fragment);
    return fragment.startsWith(open) && /\s/.test(fragment[open.length]);
  });
}

export interface ActionHandlers {
  onText(text: string): void;
  onActionStart(tag: ActionTag): void;
  onAction(action: ParsedAction): void;
}

export class ActionStream {
  private buffer = '';
  private open: { tag: ActionTag; attrs: Record<string, string> } | null = null;

  constructor(private readonly handlers: ActionHandlers) {}

  push(chunk: string): void {
    this.buffer += chunk;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    for (;;) {
      if (this.open) {
        const close = `</${this.open.tag}>`;
        const index = this.buffer.indexOf(close);
        if (index < 0) {
          // Yanıt yarıda kesildiyse eldeki gövdeyle eylemi yine de tamamla.
          if (final && this.buffer.trim()) {
            this.handlers.onAction({ ...this.open, body: this.buffer.trim() });
            this.buffer = '';
            this.open = null;
          }
          return;
        }
        const body = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + close.length).replace(/^[ \t]*\n/, '');
        const action = { ...this.open, body };
        this.open = null;
        this.handlers.onAction(action);
        continue;
      }

      const start = this.buffer.indexOf('<');
      if (start < 0) {
        if (this.buffer) this.handlers.onText(this.buffer);
        this.buffer = '';
        return;
      }
      if (start > 0) {
        this.handlers.onText(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start);
      }
      const match = this.buffer.match(OPEN_RE);
      if (match) {
        this.open = { tag: match[1] as ActionTag, attrs: parseAttrs(match[2]) };
        this.buffer = this.buffer.slice(match[0].length);
        this.handlers.onActionStart(this.open.tag);
        continue;
      }
      if (!final && mayBecomeTag(this.buffer)) return;
      // Sıradan bir "<" karakteri: metin olarak geçir.
      this.handlers.onText('<');
      this.buffer = this.buffer.slice(1);
    }
  }
}

export function innerTag(body: string, tag: string): { attrs: Record<string, string>; text: string } | null {
  const match = body.match(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)(?:</${tag}>|$)`));
  if (!match) return null;
  return { attrs: parseAttrs(match[1]), text: match[2].trim() };
}

/** Tek seferlik (akışsız) yanıtlardaki tüm blokları sırayla çıkarır. */
export function extractActions(text: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const stream = new ActionStream({
    onText() {},
    onActionStart() {},
    onAction: (action) => actions.push(action),
  });
  stream.push(text);
  stream.end();
  return actions;
}

export interface RefTokens {
  handles: string[];
  assetIds: string[];
}

/** refs="@yasin, asset:as_123" → kimlikler ve görsel kimlikleri. */
export function parseRefs(value: string | undefined): RefTokens {
  const tokens: RefTokens = { handles: [], assetIds: [] };
  if (!value) return tokens;
  for (const raw of value.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const asset = token.match(/^asset:([\w-]+)$/i);
    if (asset) tokens.assetIds.push(asset[1]);
    else tokens.handles.push(token.replace(/^@/, ''));
  }
  return tokens;
}

/** Modelin yanıtından JSON'u hoşgörülü biçimde ayıklar (kod çitleri, ön söz vb.). */
export function looseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const closer = cleaned[start] === '{' ? '}' : ']';
  for (let end = cleaned.lastIndexOf(closer); end > start; end = cleaned.lastIndexOf(closer, end - 1)) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      // Daha kısa bir aralıkla yeniden dene.
    }
  }
  return null;
}
