import { ChevronLeft, ChevronRight, Clapperboard, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Asset, Job, SpeechProvider } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { useApp, useVoices } from '../lib/queries.ts';
import { attempt, useUI } from '../lib/store.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { Field, Notice, Spinner, Switch } from '../ui/kit.tsx';
import { SizePicker, type SizeValue } from '../ui/SizePicker.tsx';

interface MontageDialogProps {
  open: boolean;
  onClose: () => void;
  /** Seçim sırasıyla klipler. */
  assets: Asset[];
  onStarted: (job: Job) => void;
}

/** Seçilen video ve görselleri tek videoda birleştirir; seslendirme, altyazı ve logolu kapanış ekleyebilir. */
export function MontageDialog({ open, onClose, assets, onStarted }: MontageDialogProps) {
  const app = useApp();
  const brands = app.entities.filter((e) => e.type === 'brand');
  const voices = useVoices(open);
  const [clips, setClips] = useState<Asset[]>([]);
  const [title, setTitle] = useState('');
  const [size, setSize] = useState<SizeValue>({ aspect: '9:16', width: 1080, height: 1920 });
  const [text, setText] = useState('');
  const [provider, setProvider] = useState<SpeechProvider | ''>('');
  const [voice, setVoice] = useState('');
  const [subtitles, setSubtitles] = useState(true);
  const [outro, setOutro] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setClips(assets);
    setTitle('');
    setText('');
    setBusy(false);
    // Yalnızca açılışta sıfırlanır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const options = voices.data ?? [];
  const active = options.find((item) => item.provider === provider) ?? options[0];
  useEffect(() => {
    if (active && !active.voices.some((item) => item.id === voice)) setVoice(active.voices[0]?.id ?? '');
  }, [active, voice]);

  const move = (index: number, step: number) =>
    setClips((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + step, 0, item);
      return next;
    });

  const seconds = clips.reduce((sum, clip) => sum + (clip.kind === 'video' ? clip.duration ?? 0 : 3), 0) + (outro ? 2.2 : 0);
  const spoken = text.trim().length > 0 && !!active;

  const submit = async () => {
    setBusy(true);
    const job = await attempt(() =>
      api.post<Job>('/api/generate/montage', {
        assetIds: clips.map((clip) => clip.id),
        width: size.width,
        height: size.height,
        title: title.trim(),
        voiceover: spoken ? { text: text.trim(), provider: active!.provider, voice: voice || undefined } : undefined,
        subtitles: spoken && subtitles,
        outroBrandId: outro || null,
      }),
    );
    setBusy(false);
    if (!job) return;
    useUI.getState().putJobs([job]);
    onStarted(job);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Montaj"
      description="Klipler soldan sağa sırayla birleştirilir. Görseller üçer saniyelik kare olur; her şey seçtiğiniz boyuta kırpılmadan sığdırılır."
      footer={
        <>
          <span className="mr-auto text-[0.84rem] text-ink-3">
            {clips.length} klip · yaklaşık {duration(Math.max(1, seconds))}
          </span>
          <button type="button" className="btn btn-outline" onClick={onClose}>Vazgeç</button>
          <button type="button" className="btn btn-accent" disabled={busy || !clips.length || !app.app.ffmpeg} onClick={submit}>
            {busy ? <Spinner /> : <Clapperboard />} Montajı başlat
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {!app.app.ffmpeg && (
          <Notice level="warn">
            Montaj için bu bilgisayarda ffmpeg kurulu olmalı. Terminalde <code className="font-mono text-[0.84rem]">brew install ffmpeg</code> komutuyla kurup Bellek'i yeniden başlatın.
          </Notice>
        )}

        <div>
          <span className="label">Sıra</span>
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {clips.map((clip, index) => (
              <li key={clip.id} className="group/c relative w-[5.5rem] flex-none">
                <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-sunken">
                  <img src={clip.thumbUrl || clip.url} alt="" className="h-full w-full object-cover" />
                  <span className="absolute top-1 left-1 rounded bg-black/65 px-1 font-mono text-[0.68rem] text-white">{index + 1}</span>
                  {clip.kind === 'video' && (
                    <span className="absolute right-1 bottom-1 inline-flex items-center gap-0.5 rounded bg-black/65 px-1 text-[0.68rem] text-white">
                      <Play className="h-2.5 w-2.5 fill-current" /> {duration(clip.duration)}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`${index + 1}. klibi çıkar`}
                    onClick={() => setClips((list) => list.filter((item) => item.id !== clip.id))}
                    className="absolute top-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white opacity-0 group-focus-within/c:opacity-100 group-hover/c:opacity-100 max-md:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="mt-1 flex justify-center gap-0.5">
                  <button type="button" className="btn btn-ghost btn-icon btn-sm !h-6 !w-6" aria-label={`${index + 1}. klibi öne al`} disabled={index === 0} onClick={() => move(index, -1)}>
                    <ChevronLeft />
                  </button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm !h-6 !w-6" aria-label={`${index + 1}. klibi sona doğru taşı`} disabled={index === clips.length - 1} onClick={() => move(index, 1)}>
                    <ChevronRight />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
          <SizePicker value={size} onChange={setSize} pixelsOnly groups={['Sosyal medya', 'Video']} customHint="Video tam bu ölçüde oluşturulur." />

          <div className="flex flex-col gap-4">
            <Field label="Ad">
              <input className="input" placeholder="Örn. Kış harmanı tanıtımı" value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label="Kapanış" hint="Sona, markanın logosunu taşıyan kısa bir kare eklenir.">
              <select className="input" value={outro} onChange={(event) => setOutro(event.target.value)}>
                <option value="">Kapanış yok</option>
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>{brand.name}</option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <div>
          <Field label="Seslendirme metni" hint={options.length ? 'Boş bırakırsanız kliplerin kendi sesi kalır.' : undefined}>
            <textarea
              className="input"
              rows={3}
              placeholder="Videonun üzerine okunacak metni yazın."
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={!options.length && !voices.isLoading}
              maxLength={4000}
            />
          </Field>
          {!voices.isLoading && !options.length && (
            <p className="hint mt-1.5">Seslendirme için OpenAI ya da Gemini anahtarı ekleyin; Mac'te yerleşik ses de kullanılabilir.</p>
          )}
          {text.trim() && active && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="Ses kaynağı" className="w-48">
                <select className="input" value={active.provider} onChange={(event) => setProvider(event.target.value as SpeechProvider)}>
                  {options.map((item) => (
                    <option key={item.provider} value={item.provider}>{item.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Ses" className="w-44">
                <select className="input" value={voice} onChange={(event) => setVoice(event.target.value)}>
                  {active.voices.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </Field>
              <label className="flex h-[2.6rem] items-center gap-2.5 text-[0.9rem]">
                <Switch checked={subtitles} label="Altyazı ekle" onChange={setSubtitles} />
                Altyazı ekle
              </label>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
