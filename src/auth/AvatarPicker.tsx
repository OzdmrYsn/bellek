import { Camera } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Me } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { toast } from '../lib/store.ts';
import { Spinner, UserAvatar } from '../ui/kit.tsx';

async function uploadAvatar(file: File): Promise<Me> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/auth/me/avatar', { method: 'POST', body: form });
  const body = (await response.json().catch(() => null)) as (Me & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? 'Profil resmi yüklenemedi.');
  return body;
}

/** Profil resmi seçici: resme tıklanır, dosya seçilir, hemen yüklenir. */
export function AvatarPicker({ me, name, size = 76, onChange }: { me: Me; name?: string; size?: number; onChange: (me: Me) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File) => {
    setBusy(true);
    try {
      onChange(await uploadAvatar(file));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Profil resmi yüklenemedi.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      onChange(await api.del<Me>('/api/auth/me/avatar'));
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Profil resmi kaldırılamadı.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        className="group relative flex-none rounded-full"
        style={{ width: size, height: size }}
        aria-label={me.avatarUrl ? 'Profil resmini değiştir' : 'Profil resmi ekle'}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <UserAvatar user={{ name: name ?? me.name ?? me.email, avatarUrl: me.avatarUrl }} size={size} />
        <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
          {busy ? <Spinner /> : <Camera className="h-5 w-5" />}
        </span>
      </button>
      <div className="flex flex-col items-start gap-1">
        <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Spinner /> : <Camera />} {me.avatarUrl ? 'Resmi değiştir' : 'Resim seç'}
        </button>
        {me.avatarUrl ? (
          <button type="button" className="text-[0.82rem] text-ink-3 underline underline-offset-2 hover:text-ink" disabled={busy} onClick={remove}>
            Resmi kaldır
          </button>
        ) : (
          <span className="hint">İsteğe bağlı. JPG, PNG ya da WebP.</span>
        )}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/jpeg,image/png,image/webp,image/heic"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void pick(file);
          event.target.value = '';
        }}
      />
    </div>
  );
}
