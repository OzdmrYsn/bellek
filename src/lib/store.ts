import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Asset, AssetKind, ChatMode, Job, MessageOptions } from '../../shared/types.ts';

export type Theme = 'system' | 'light' | 'dark';

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export interface PickerRequest {
  title: string;
  multiple: boolean;
  kind?: AssetKind;
  resolve: (ids: string[]) => void;
}

/** Başka bir sayfadan stüdyoya taşınan hazır istek (ör. "bu görseli düzenle"). */
export interface Prefill {
  text?: string;
  attachments?: string[];
  mode?: ChatMode;
}

interface UIState {
  theme: Theme;
  setTheme: (theme: Theme) => void;

  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void;
  dismissToast: (id: number) => void;

  jobs: Record<string, Job>;
  putJobs: (jobs: Job[]) => void;
  pending: Record<string, string | null>;
  setPending: (messageId: string, label: string | null) => void;

  lightbox: { ids: string[]; index: number } | null;
  openLightbox: (ids: string[], index: number) => void;
  setLightboxIndex: (index: number) => void;
  closeLightbox: () => void;

  /** "Fotoğraftan kişi seç" penceresinde açık olan görsel. */
  peopleAsset: Asset | null;
  openPeople: (asset: Asset) => void;
  closePeople: () => void;

  confirmRequest: ConfirmRequest | null;
  confirm: (request: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>;
  settleConfirm: (ok: boolean) => void;

  pickerRequest: PickerRequest | null;
  pickAssets: (request: Omit<PickerRequest, 'resolve'>) => Promise<string[]>;
  settlePicker: (ids: string[]) => void;

  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  options: MessageOptions;
  setOptions: (patch: Partial<MessageOptions>) => void;
  /** Video oranı görsel oranından ayrı hatırlanır. */
  videoAspect: string;
  setVideoAspect: (aspect: string) => void;
  /** Video için seçilmiş tam piksel ölçüsü; yoksa modelin kendi çözünürlüğü kullanılır. */
  videoSize: { width: number; height: number } | null;
  setVideoSize: (size: { width: number; height: number } | null) => void;
  drafts: Record<string, string>;
  setDraft: (key: string, text: string) => void;
  draftAttachments: Record<string, string[]>;
  setDraftAttachments: (key: string, ids: string[]) => void;
  prefill: Prefill | null;
  setPrefill: (prefill: Prefill | null) => void;
}

let toastId = 0;

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },

      navOpen: false,
      setNavOpen: (navOpen) => set({ navOpen }),
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

      toasts: [],
      toast: (text, kind = 'info', action) => {
        const id = ++toastId;
        set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, text, action }] }));
        window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : action ? 7000 : 3800);
      },
      dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

      jobs: {},
      putJobs: (jobs) => {
        if (!jobs.length) return;
        set((state) => {
          const next = { ...state.jobs };
          for (const job of jobs) next[job.id] = job;
          return { jobs: next };
        });
      },
      pending: {},
      setPending: (messageId, label) => set((state) => ({ pending: { ...state.pending, [messageId]: label } })),

      lightbox: null,
      openLightbox: (ids, index) => set({ lightbox: { ids, index } }),
      setLightboxIndex: (index) => set((state) => (state.lightbox ? { lightbox: { ...state.lightbox, index } } : {})),
      closeLightbox: () => set({ lightbox: null }),

      peopleAsset: null,
      openPeople: (peopleAsset) => set({ peopleAsset }),
      closePeople: () => set({ peopleAsset: null }),

      confirmRequest: null,
      confirm: (request) =>
        new Promise<boolean>((resolve) => {
          get().confirmRequest?.resolve(false);
          set({ confirmRequest: { ...request, resolve } });
        }),
      settleConfirm: (ok) => {
        get().confirmRequest?.resolve(ok);
        set({ confirmRequest: null });
      },

      pickerRequest: null,
      pickAssets: (request) =>
        new Promise<string[]>((resolve) => {
          get().pickerRequest?.resolve([]);
          set({ pickerRequest: { ...request, resolve } });
        }),
      settlePicker: (ids) => {
        get().pickerRequest?.resolve(ids);
        set({ pickerRequest: null });
      },

      mode: 'auto',
      setMode: (mode) => set({ mode }),
      options: {},
      setOptions: (patch) => set((state) => ({ options: { ...state.options, ...patch } })),
      videoAspect: '9:16',
      setVideoAspect: (videoAspect) => set({ videoAspect }),
      videoSize: null,
      setVideoSize: (videoSize) => set({ videoSize }),
      drafts: {},
      setDraft: (key, text) =>
        set((state) => {
          const drafts = { ...state.drafts };
          if (text) drafts[key] = text;
          else delete drafts[key];
          return { drafts };
        }),
      draftAttachments: {},
      setDraftAttachments: (key, ids) =>
        set((state) => {
          const draftAttachments = { ...state.draftAttachments };
          if (ids.length) draftAttachments[key] = ids;
          else delete draftAttachments[key];
          return { draftAttachments };
        }),
      prefill: null,
      setPrefill: (prefill) => set({ prefill }),
    }),
    {
      name: 'bellek.arayuz',
      // Yarım kalan istemler tarayıcıda saklanır: sayfa yenilense de yazı kaybolmaz.
      partialize: (state) => ({
        theme: state.theme,
        mode: state.mode,
        options: state.options,
        videoAspect: state.videoAspect,
        videoSize: state.videoSize,
        drafts: state.drafts,
        draftAttachments: state.draftAttachments,
      }),
    },
  ),
);

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem('bellek.tema');
    else localStorage.setItem('bellek.tema', theme);
  } catch {
    // Depolama kapalıysa tema yalnızca bu oturumda geçerli olur.
  }
}

export const toast = (text: string, kind?: Toast['kind'], action?: Toast['action']) => useUI.getState().toast(text, kind, action);
export const confirmDialog = (request: Omit<ConfirmRequest, 'resolve'>) => useUI.getState().confirm(request);
export const pickAssets = (request: Omit<PickerRequest, 'resolve'>) => useUI.getState().pickAssets(request);

/** Hata yakalayıp kullanıcıya gösteren küçük sarmalayıcı. */
export async function attempt<T>(run: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await run();
    if (success) toast(success, 'ok');
    return result;
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Bir şeyler ters gitti.', 'error');
    return undefined;
  }
}
