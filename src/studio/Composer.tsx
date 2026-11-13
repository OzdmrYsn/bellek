import {
  ArrowUp, Clapperboard, FolderOpen, Image as ImageIcon, MessageSquareText, Newspaper, Paperclip, SlidersHorizontal,
  Sparkles, Square, Upload, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { findMentions } from '../../shared/handles.ts';
import { ASPECTS, nearestAspect } from '../../shared/platforms.ts';
import type { ChatMode, Entity, MessageOptions, ModelRef } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { cx } from '../lib/format.ts';
import { useActiveModel, useApp, useModels } from '../lib/queries.ts';
import { pickAssets, useUI } from '../lib/store.ts';
import { ACCEPT_ATTR, filesFromDrop, hasFiles, mediaFiles, uploadFiles } from '../library/upload.ts';
import { Avatar, Notice, Segmented, Spinner, Switch } from '../ui/kit.tsx';
import { Menu, Popover } from '../ui/Popover.tsx';
import { SizePicker, sizeLabel, type SizeValue } from '../ui/SizePicker.tsx';
import { MentionInput, type MentionInputHandle } from './MentionInput.tsx';

const MODES: { value: ChatMode; label: string; icon: React.ReactNode; title: string }[] = [
  { value: 'auto', label: 'Otomatik', icon: <Sparkles />, title: 'Ne gerektiğine Bellek karar versin' },
  { value: 'text', label: 'Metin', icon: <MessageSquareText />, title: 'Yalnızca yazılı yanıt' },
  { value: 'image', label: 'Görsel', icon: <ImageIcon />, title: 'Görsel üret' },
  { value: 'video', label: 'Video', icon: <Clapperboard />, title: 'Video üret' },
  { value: 'post', label: 'Gönderi', icon: <Newspaper />, title: 'Sosyal medya gönderisi hazırla' },
];

const PLACEHOLDER: Record<ChatMode, string> = {
  auto: 'Ne üretelim? @ yazarak bir kişi ya da marka çağırın',
  text: 'Bir şey sorun ya da bir metin isteyin',
  image: 'Görseli anlatın; @ ile kişileri ve markaları ekleyin',
  video: 'Videoyu anlatın ya da bir görsel ekleyip canlandırın',
  post: 'Hangi konuda, hangi platform için bir gönderi?',
};

export interface SendPayload {
  content: string;
  mode: ChatMode;
  attachments: string[];
  options: MessageOptions;
}

interface ComposerProps {
  draftKey: string;
  onSend: (payload: SendPayload) => Promise<boolean>;
  /** Akan bir yanıt varsa durdurma düğmesi gösterilir. */
  streamingId?: string | null;
  autoFocus?: boolean;
}

function ModelSelect({ label, models, value, onChange, fallback }: { label: string; models: ModelRef[]; value: string | undefined; onChange: (ref: string | undefined) => void; fallback: ModelRef | null }) {
  if (!models.length) {
    return (
      <div>
        <span className="label">{label}</span>
        <Link to="/ayarlar" className="text-[0.86rem] text-accent-text underline underline-offset-2">
          Bağlı model yok — bir anahtar ekleyin
        </Link>
      </div>
    );
  }
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select className="input !h-9 !text-[0.88rem]" value={value && models.some((m) => m.ref === value) ? value : ''} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">Varsayılan{fallback ? ` · ${fallback.model.label}` : ''}</option>
        {models.map((model) => (
          <option key={model.ref} value={model.ref}>
            {model.model.label} — {model.providerName}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Composer({ draftKey, onSend, streamingId, autoFocus }: ComposerProps) {
  const app = useApp();
  const mode = useUI((s) => s.mode);
  const setMode = useUI((s) => s.setMode);
  const options = useUI((s) => s.options);
  const setOptions = useUI((s) => s.setOptions);
  const videoAspect = useUI((s) => s.videoAspect);
  const setVideoAspect = useUI((s) => s.setVideoAspect);
  const videoSize = useUI((s) => s.videoSize);
  const setVideoSize = useUI((s) => s.setVideoSize);
  const text = useUI((s) => s.drafts[draftKey] ?? '');
  const setDraft = useUI((s) => s.setDraft);
  const attachments = useUI((s) => s.draftAttachments[draftKey]);
  const setAttachments = useUI((s) => s.setDraftAttachments);
  const prefill = useUI((s) => s.prefill);
  const setPrefill = useUI((s) => s.setPrefill);

  const input = useRef<MentionInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const attached = useMemo(() => attachments ?? [], [attachments]);

  const textModels = useModels('text');
  const imageModels = useModels('image');
  const videoModels = useModels('video');
  const activeText = useActiveModel('text', options.textModel);
  const activeImage = useActiveModel('image', options.imageModels?.[0]);
  const activeVideo = useActiveModel('video', options.videoModel);
  const generation = app.settings.generation;

  // Başka bir sayfadan gelen hazır istek ("bu görseli düzenle" gibi).
  useEffect(() => {
    if (!prefill) return;
    if (prefill.mode) setMode(prefill.mode);
    if (prefill.text !== undefined) setDraft(draftKey, prefill.text);
    if (prefill.attachments?.length) setAttachments(draftKey, [...new Set([...attached, ...prefill.attachments])]);
    setPrefill(null);
    window.requestAnimationFrame(() => input.current?.focus());
  }, [prefill, draftKey, attached, setMode, setDraft, setAttachments, setPrefill]);

  const mentioned = useMemo(() => {
    const seen = new Set<string>();
    const list: Entity[] = [];
    for (const mention of findMentions(text)) {
      const entity = app.entities.find((e) => e.handle === mention.handle);
      if (entity && !seen.has(entity.id)) {
        seen.add(entity.id);
        list.push(entity);
      }
    }
    return list;
  }, [text, app.entities]);

  const aspect = options.aspect ?? generation.aspect;
  const count = options.count ?? generation.count;
  const videoDurations = activeVideo?.model.durations ?? [5, 8, 10];
  const duration = options.duration ?? generation.videoDuration;
  const videoAspects = activeVideo?.model.aspects?.length ? activeVideo.model.aspects : ['16:9', '9:16'];
  const enhance = options.enhance ?? generation.enhance;
  const imageSize: SizeValue = { aspect, width: options.width, height: options.height };
  const videoValue: SizeValue = {
    aspect: videoAspects.includes(videoAspect) ? videoAspect : videoAspects[0],
    width: videoSize?.width,
    height: videoSize?.height,
  };
  const selectedImageModels = (options.imageModels ?? []).filter((ref) => imageModels.some((m) => m.ref === ref));

  const summary = (() => {
    if (mode === 'image') {
      const model = selectedImageModels.length > 1 ? `${selectedImageModels.length} model` : activeImage?.model.label;
      return [sizeLabel(imageSize), `${count} adet`, model].filter(Boolean).join(' · ');
    }
    if (mode === 'video') return [sizeLabel(videoValue), `${duration} sn`, activeVideo?.model.label].filter(Boolean).join(' · ');
    return activeText?.model.label ?? 'Model seçilmedi';
  })();

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const uploaded = await uploadFiles(files);
    setUploading(false);
    if (uploaded.length) setAttachments(draftKey, [...new Set([...attached, ...uploaded.map((a) => a.id)])]);
  };

  const fromLibrary = async () => {
    const ids = await pickAssets({ title: 'Kütüphaneden ekle', multiple: true, kind: 'image' });
    if (ids.length) setAttachments(draftKey, [...new Set([...attached, ...ids])]);
  };

  const canSend = (text.trim().length > 0 || attached.length > 0) && !sending && !uploading;

  const send = async () => {
    if (!canSend) return;
    const payload: SendPayload = {
      content: text.trim(),
      mode,
      attachments: attached,
      options: {
        textModel: options.textModel,
        imageModels: selectedImageModels.length ? selectedImageModels : undefined,
        videoModel: options.videoModel,
        aspect: mode === 'video' ? videoValue.aspect : aspect,
        width: mode === 'video' ? videoValue.width : mode === 'text' ? undefined : imageSize.width,
        height: mode === 'video' ? videoValue.height : mode === 'text' ? undefined : imageSize.height,
        count,
        duration: videoDurations.includes(duration) ? duration : videoDurations[0],
        enhance,
        keyframe: options.keyframe,
        quality: options.quality,
      },
    };
    setSending(true);
    // Metni hemen temizle; gönderim başarısız olursa geri konur.
    setDraft(draftKey, '');
    setAttachments(draftKey, []);
    const ok = await onSend(payload);
    setSending(false);
    if (!ok) {
      setDraft(draftKey, payload.content);
      setAttachments(draftKey, payload.attachments);
    }
    input.current?.focus();
  };

  const toggleImageModel = (ref: string) => {
    const current = selectedImageModels;
    const next = current.includes(ref) ? current.filter((r) => r !== ref) : [...current, ref].slice(-4);
    setOptions({ imageModels: next });
  };

  return (
    <div className="flex flex-col gap-2">
      {app.models.length === 0 && (
        <Notice
          level="warn"
          action={
            <Link to="/ayarlar" className="btn btn-outline btn-sm flex-none">
              Ayarlar'ı aç
            </Link>
          }
        >
          Henüz bir yapay zekâ bağlı değil. Kendi API anahtarınızı ekleyince üretime başlayabilirsiniz.
        </Notice>
      )}

      <div
        className={cx(
          'relative rounded-[18px] border bg-surface shadow-card transition-[border-color,box-shadow] duration-150',
          dropping ? 'border-accent-text ring-4 ring-accent/20' : 'border-line focus-within:border-line-strong',
        )}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropping(false);
          void addFiles(filesFromDrop(event));
        }}
      >
        <div className="flex px-2 pt-2">
          <Segmented size="sm" value={mode} onChange={setMode} options={MODES} className="max-w-full overflow-x-auto max-sm:[&_button[aria-checked=false]_[data-label]]:hidden" />
        </div>

        {(mentioned.length > 0 || attached.length > 0 || uploading) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
            {mentioned.map((entity) => {
              const used = Math.min(entity.assetCount, generation.refsPerEntity);
              return (
                <Link
                  key={entity.id}
                  to={`/hafiza/${entity.id}`}
                  title={`${entity.name} — hafızadaki bilgileri ve referans görselleri bu isteğe eklenecek`}
                  className="flex h-8 items-center gap-1.5 rounded-full bg-accent-soft pr-3 pl-1 text-[0.82rem] text-accent-text"
                >
                  <Avatar entity={entity} size={24} />
                  <span className="font-medium">{entity.name}</span>
                  <span className="opacity-80">
                    {entity.assetCount ? `· ${used} referans` : '· görsel yok'}
                  </span>
                </Link>
              );
            })}
            {attached.map((id) => (
              <span key={id} className="group/att relative h-12 w-12 overflow-hidden rounded-lg bg-sunken">
                <img src={`/media/${id}/thumb`} alt="Ek görsel" className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label="Eki kaldır"
                  onClick={() => setAttachments(draftKey, attached.filter((x) => x !== id))}
                  className="absolute top-0.5 right-0.5 grid h-4.5 w-4.5 place-items-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover/att:opacity-100 focus-visible:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {uploading && (
              <span className="grid h-12 w-12 place-items-center rounded-lg bg-sunken text-ink-3">
                <Spinner />
              </span>
            )}
          </div>
        )}

        <MentionInput
          ref={input}
          ariaLabel="İstek"
          value={text}
          onChange={(value) => setDraft(draftKey, value)}
          onSubmit={send}
          entities={app.entities}
          placeholder={PLACEHOLDER[mode]}
          autoFocus={autoFocus}
          onFiles={(files) => void addFiles(files)}
          className="px-4 pt-2.5 pb-1 text-[1.02rem] leading-[1.55]"
        />

        <div className="flex items-center gap-1.5 p-2">
          <Popover
            placement="top-start"
            className="w-[21rem] !p-4"
            trigger={(props) => (
              <button type="button" {...props} className="btn btn-ghost btn-sm min-w-0 !font-normal" title="Üretim ayarları">
                <SlidersHorizontal />
                <span className="truncate">{summary}</span>
              </button>
            )}
          >
            {() => (
              <div className="flex flex-col gap-4">
                {mode !== 'video' && mode !== 'text' && (
                  <SizePicker
                    value={imageSize}
                    onChange={(value) => setOptions({ aspect: value.aspect, width: value.width, height: value.height })}
                    aspects={ASPECTS.map((a) => a.id)}
                  />
                )}
                {(mode === 'image' || mode === 'auto') && (
                  <div className="flex items-center justify-between">
                    <span className="label !mb-0">Kaç seçenek</span>
                    <Segmented
                      size="sm"
                      value={String(count)}
                      onChange={(value) => setOptions({ count: Number(value) })}
                      options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))}
                    />
                  </div>
                )}
                {mode === 'video' && (
                  <>
                    <SizePicker
                      value={videoValue}
                      aspects={videoAspects}
                      groups={['Sosyal medya', 'Video']}
                      onChange={(value) => {
                        // Model yalnızca kendi oranlarında üretir; piksel ölçüsü çıktıya sonradan uygulanır.
                        setVideoAspect(nearestAspect(value.aspect, videoAspects));
                        setVideoSize(value.width && value.height ? { width: value.width, height: value.height } : null);
                      }}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <span className="label !mb-0">Süre</span>
                      <Segmented
                        size="sm"
                        value={String(videoDurations.includes(duration) ? duration : videoDurations[0])}
                        onChange={(value) => setOptions({ duration: Number(value) })}
                        options={videoDurations.map((n) => ({ value: String(n), label: `${n} sn` }))}
                      />
                    </div>
                  </>
                )}

                {mode !== 'video' && mode !== 'image' && (
                  <ModelSelect label="Metin modeli" models={textModels} value={options.textModel} onChange={(ref) => setOptions({ textModel: ref })} fallback={activeText} />
                )}

                {mode !== 'text' && mode !== 'video' && (
                  <div>
                    <span className="label">
                      Görsel modeli
                      {mode === 'image' && imageModels.length > 1 && <span className="font-normal text-ink-3"> — birden fazla seçerek karşılaştırın</span>}
                    </span>
                    {imageModels.length === 0 ? (
                      <Link to="/ayarlar" className="text-[0.86rem] text-accent-text underline underline-offset-2">
                        Bağlı model yok — bir anahtar ekleyin
                      </Link>
                    ) : (
                      <div className="flex max-h-44 flex-col gap-px overflow-y-auto rounded-lg border border-line p-1">
                        {imageModels.map((model) => {
                          const checked = selectedImageModels.includes(model.ref) || (!selectedImageModels.length && activeImage?.ref === model.ref);
                          return (
                            <label key={model.ref} className="menu-item !py-1.5 !text-[0.86rem]">
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 accent-[var(--accent-text)]"
                                checked={checked}
                                onChange={() => (selectedImageModels.length ? toggleImageModel(model.ref) : setOptions({ imageModels: checked ? [] : [model.ref] }))}
                              />
                              <span className="min-w-0 flex-1 truncate">{model.model.label}</span>
                              <span className="text-[0.74rem] text-ink-3">{model.providerName.split(' · ')[0]}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {(mode === 'video' || mode === 'auto') && (
                  <ModelSelect label="Video modeli" models={videoModels} value={options.videoModel} onChange={(ref) => setOptions({ videoModel: ref })} fallback={activeVideo} />
                )}

                {(mode === 'image' || mode === 'video') && (
                  <>
                    <label className="flex items-center justify-between gap-4">
                      <span>
                        <span className="block text-[0.9rem] font-medium">İstemi zenginleştir</span>
                        <span className="hint">Metin modeli, hafızadaki bilgileri kullanarak istemi geliştirir.</span>
                      </span>
                      <Switch checked={enhance} onChange={(value) => setOptions({ enhance: value })} label="İstemi zenginleştir" disabled={!activeText} />
                    </label>
                    {mode === 'video' && (
                      <label className="flex items-center justify-between gap-4">
                        <span>
                          <span className="block text-[0.9rem] font-medium">Önce anahtar kare</span>
                          <span className="hint">Referanslardan bir görsel üretip onu canlandırır; yüz benzerliği artar.</span>
                        </span>
                        <Switch checked={!!options.keyframe} onChange={(value) => setOptions({ keyframe: value })} label="Önce anahtar kare" disabled={!activeImage} />
                      </label>
                    )}
                  </>
                )}
              </div>
            )}
          </Popover>

          <span className="flex-1" />
          <Menu
            placement="top-end"
            trigger={(props) => (
              <button type="button" {...props} className="btn btn-ghost btn-icon btn-sm flex-none" aria-label="Görsel ekle" title="Görsel ekle">
                <Paperclip />
              </button>
            )}
            items={[
              { label: 'Bilgisayardan yükle', icon: <Upload />, onSelect: () => fileInput.current?.click() },
              { label: 'Kütüphaneden seç', icon: <FolderOpen />, onSelect: () => void fromLibrary() },
            ]}
          />
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept={ACCEPT_ATTR}
            onChange={(event) => {
              void addFiles(mediaFiles(event.target.files));
              event.target.value = '';
            }}
          />

          {streamingId ? (
            <button
              type="button"
              className="btn btn-primary btn-icon btn-sm !rounded-full"
              aria-label="Yanıtı durdur"
              title="Yanıtı durdur"
              onClick={() => void api.post(`/api/messages/${streamingId}/stop`)}
            >
              <Square className="!h-3.5 !w-3.5 fill-current" />
            </button>
          ) : (
            <button type="button" className="btn btn-accent btn-sm !h-8 flex-none !rounded-full !px-3.5" disabled={!canSend} onClick={send}>
              {sending ? <Spinner /> : <ArrowUp strokeWidth={2.5} />}
              {mode === 'text' ? 'Gönder' : 'Üret'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
