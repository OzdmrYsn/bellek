import { QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  Asset, BackupStatus, Bootstrap, Campaign, Conversation, ConversationDetail, Design, Entity, EntityDetail, Job, Memory,
  ModelKind, ModelRef, Post, SpeechOption, TrashItem, UsageReport,
} from '../../shared/types.ts';
import { api, qs } from './api.ts';
import { useUI } from './store.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export const keys = {
  bootstrap: ['bootstrap'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  entity: (id: string) => ['entity', id] as const,
  assets: (filter: object) => ['assets', filter] as const,
  asset: (id: string) => ['asset', id] as const,
  posts: (filter: object) => ['posts', filter] as const,
  post: (id: string) => ['post', id] as const,
  memories: (entityId?: string) => ['memories', entityId ?? 'all'] as const,
  designs: ['designs'] as const,
  design: (id: string) => ['design', id] as const,
  backup: ['backup'] as const,
  trash: ['trash'] as const,
  usage: (days: number) => ['usage', days] as const,
  campaigns: ['campaigns'] as const,
  voices: ['voices'] as const,
};

export function useBootstrap() {
  return useQuery({ queryKey: keys.bootstrap, queryFn: () => api.get<Bootstrap>('/api/bootstrap'), staleTime: 60_000 });
}

/** Açılış verisi yüklendikten sonra kullanılır; kabuk bunu garanti eder. */
export function useApp(): Bootstrap {
  const { data } = useBootstrap();
  if (!data) throw new Error('Uygulama verisi henüz yüklenmedi.');
  return data;
}

export function useEntities(): Entity[] {
  return useApp().entities;
}

export function useConversations(): Conversation[] {
  return useApp().conversations;
}

export function useModels(kind: ModelKind): ModelRef[] {
  return useApp().models.filter((m) => m.model.kind === kind);
}

/** Seçili model yoksa varsayılanı, o da yoksa ilk hazır modeli döndürür. */
export function useActiveModel(kind: ModelKind, preferred?: string | null): ModelRef | null {
  const app = useApp();
  const models = app.models.filter((m) => m.model.kind === kind);
  return (
    models.find((m) => m.ref === preferred) ??
    models.find((m) => m.ref === app.settings.defaults[kind]) ??
    models[0] ??
    null
  );
}

export function refreshApp(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: keys.bootstrap });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: keys.conversation(id ?? ''),
    enabled: !!id,
    queryFn: async () => {
      const detail = await api.get<ConversationDetail>(`/api/conversations/${id}`);
      useUI.getState().putJobs(detail.jobs);
      return detail;
    },
  });
}

export function useEntity(id: string | undefined) {
  return useQuery({
    queryKey: keys.entity(id ?? ''),
    enabled: !!id,
    queryFn: () => api.get<EntityDetail>(`/api/entities/${id}`),
  });
}

export interface AssetFilter {
  kind?: string;
  source?: string;
  entity?: string;
  favorite?: boolean;
  q?: string;
  trashed?: boolean;
}

interface AssetPage {
  items: Asset[];
  nextCursor: string | null;
}

export function useAssets(filter: AssetFilter, pageSize = 60) {
  return useInfiniteQuery({
    queryKey: keys.assets(filter),
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<AssetPage>(`/api/assets${qs({ ...filter, before: pageParam, limit: pageSize })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: keys.asset(id ?? ''),
    enabled: !!id,
    queryFn: () => api.get<Asset>(`/api/assets/${id}`),
    staleTime: 60_000,
  });
}

export function usePosts(filter: { from?: string; to?: string; brand?: string; status?: string; campaign?: string } = {}) {
  return useQuery({ queryKey: keys.posts(filter), queryFn: () => api.get<Post[]>(`/api/posts${qs(filter)}`) });
}

export function usePost(id: string | undefined) {
  return useQuery({ queryKey: keys.post(id ?? ''), enabled: !!id, queryFn: () => api.get<Post>(`/api/posts/${id}`) });
}

export function useMemories(entityId?: string) {
  return useQuery({
    queryKey: keys.memories(entityId),
    queryFn: () => api.get<Memory[]>(`/api/memories${qs({ entity: entityId })}`),
  });
}

export function useDesigns() {
  return useQuery({ queryKey: keys.designs, queryFn: () => api.get<Design[]>('/api/designs') });
}

export function useDesign(id: string | undefined) {
  return useQuery({
    queryKey: keys.design(id ?? ''),
    enabled: !!id,
    queryFn: () => api.get<Design>(`/api/designs/${id}`),
    staleTime: Infinity,
  });
}

export function useBackup() {
  return useQuery({ queryKey: keys.backup, queryFn: () => api.get<BackupStatus>('/api/backup') });
}

export function useTrash() {
  return useQuery({ queryKey: keys.trash, queryFn: () => api.get<TrashItem[]>('/api/trash') });
}

export function useUsage(days: number) {
  return useQuery({ queryKey: keys.usage(days), queryFn: () => api.get<UsageReport>(`/api/usage${qs({ days })}`) });
}

export function useCampaigns() {
  return useQuery({ queryKey: keys.campaigns, queryFn: () => api.get<Campaign[]>('/api/campaigns') });
}

/** Seslendirme için kullanılabilir sağlayıcılar ve sesleri; yalnızca gerektiğinde çekilir. */
export function useVoices(enabled: boolean) {
  return useQuery({ queryKey: keys.voices, enabled, staleTime: 300_000, queryFn: () => api.get<SpeechOption[]>('/api/generate/voices') });
}

/** Depodaki iş; yoksa sunucudan bir kez çekilir. */
export function useJob(id: string): Job | undefined {
  const job = useUI((state) => state.jobs[id]);
  useQuery({
    queryKey: ['job', id],
    enabled: !job,
    queryFn: async () => {
      const fetched = await api.get<Job>(`/api/jobs/${id}`);
      useUI.getState().putJobs([fetched]);
      return fetched;
    },
  });
  return job;
}

export function invalidateAssets(): void {
  void queryClient.invalidateQueries({ queryKey: ['assets'] });
}
