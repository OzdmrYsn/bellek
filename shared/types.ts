// Sunucu ile arayüzün ortak sözleşmesi. API'den dönen her şey buradaki tiplerle konuşur.

export type ID = string;

// ───────────────────────── Medya ─────────────────────────

export type AssetKind = 'image' | 'video';
export type AssetSource = 'upload' | 'generated' | 'crop' | 'design';

export interface Asset {
  id: ID;
  kind: AssetKind;
  source: AssetSource;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  title: string | null;
  prompt: string | null;
  model: string | null;
  provider: string | null;
  params: Record<string, unknown> | null;
  parentId: ID | null;
  jobId: ID | null;
  favorite: boolean;
  tags: string[];
  createdAt: string;
  deletedAt: string | null;
  url: string;
  thumbUrl: string;
  /** Bu görseli referans olarak kullanan varlıklar. */
  entityIds: ID[];
}

// ───────────────────────── Hafıza ─────────────────────────

export type EntityType = 'person' | 'brand' | 'product' | 'style' | 'place';

export type BrandColorRole = 'primary' | 'secondary' | 'accent' | 'neutral' | 'background' | 'text';

export interface BrandColor {
  name: string;
  hex: string;
  role: BrandColorRole;
}

/** Marka kiti. Diğer varlık türleri bu alanların yalnızca bir kısmını kullanır. */
export interface EntityData {
  // marka
  tagline?: string;
  industry?: string;
  audience?: string;
  tone?: string;
  values?: string;
  colors?: BrandColor[];
  fonts?: { heading?: string; body?: string };
  hashtags?: string[];
  dos?: string;
  donts?: string;
  website?: string;
  socials?: Partial<Record<PlatformId, string>>;
  emoji?: 'none' | 'light' | 'rich';
  // kişi
  role?: string;
  // ürün
  category?: string;
  price?: string;
}

export type EntityAssetRole = 'reference' | 'logo' | 'example';

export interface Entity {
  id: ID;
  type: EntityType;
  name: string;
  handle: string;
  description: string;
  /** Yapay zekânın referans fotoğraflardan çıkardığı görünüm / üslup profili. */
  profile: string;
  data: EntityData;
  avatarAssetId: ID | null;
  avatarUrl: string | null;
  /** Kart önizlemesi için ilk birkaç referansın küçük görselleri. */
  previewUrls: string[];
  pinned: boolean;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface EntityAsset extends Asset {
  role: EntityAssetRole;
  position: number;
  note: string | null;
}

export interface EntityDetail extends Entity {
  assets: EntityAsset[];
  memories: Memory[];
  /** Bu varlıkla üretilmiş son çıktılar. */
  generations: Asset[];
}

export type MemoryCategory = 'fact' | 'preference' | 'style' | 'rule';

export interface Memory {
  id: ID;
  content: string;
  category: MemoryCategory;
  entityId: ID | null;
  source: 'manual' | 'auto';
  pinned: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ───────────────────────── Sohbet ─────────────────────────

export type ChatMode = 'auto' | 'text' | 'image' | 'video' | 'post';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'job'; jobId: ID }
  | { type: 'post'; postId: ID }
  | { type: 'memory'; memoryId: ID; content: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; action?: 'settings' };

export interface MessageOptions {
  textModel?: string;
  /** Birden fazla model seçilirse aynı istem yan yana karşılaştırılır. */
  imageModels?: string[];
  videoModel?: string;
  aspect?: string;
  count?: number;
  duration?: number;
  resolution?: string;
  quality?: string;
  /** Tam piksel boyutu; verilirse oran bundan türetilir ve çıktı bu ölçüye getirilir. */
  width?: number;
  height?: number;
  /** İstemi hafızadaki bilgilerle zenginleştir. */
  enhance?: boolean;
  /** Video için önce referanslardan bir anahtar kare üret. */
  keyframe?: boolean;
}

export interface Mention {
  entityId: ID;
  handle: string;
}

export interface Usage {
  input: number;
  output: number;
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped';

export interface Message {
  id: ID;
  conversationId: ID;
  role: 'user' | 'assistant';
  content: string;
  parts: MessagePart[];
  mode: ChatMode;
  mentions: Mention[];
  attachments: ID[];
  options: MessageOptions;
  model: string | null;
  status: MessageStatus;
  error: string | null;
  usage: Usage | null;
  createdAt: string;
}

export interface Conversation {
  id: ID;
  title: string;
  pinned: boolean;
  /** Sohbete sabitlenen marka: her istekte bağlama eklenir. */
  brandId: ID | null;
  preview: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
  jobs: Job[];
  posts: Post[];
  /** Mesajlarda geçen ekler ve üretimler. */
  assets: Asset[];
}

// ───────────────────────── Üretim işleri ─────────────────────────

export type JobType = 'image' | 'video';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface JobRef {
  assetId: ID;
  label: string;
  entityId?: ID;
}

export type JobOp = 'generate' | 'inpaint' | 'remove-bg' | 'upscale' | 'montage';

export interface MontageSpec {
  /** Sırayla birleştirilecek video ve görseller. */
  assetIds: ID[];
  width: number;
  height: number;
  voiceover?: { text: string; provider: SpeechProvider; voice?: string };
  subtitles?: boolean;
  /** Sona logolu kapanış eklenecek marka. */
  outroBrandId?: ID | null;
  title?: string;
}

export type SpeechProvider = 'local' | 'openai' | 'google';

export interface JobInput {
  /** Varsayılan: 'generate'. */
  op?: JobOp;
  /** Düzenleme ve araç işlerinde kaynak görsel. */
  sourceAssetId?: ID;
  /** Bölge düzenlemede maske dosyasının adı (veri klasöründe). */
  maskFile?: string;
  montage?: MontageSpec;
  /** Çıktının getirileceği tam piksel boyutu. */
  width?: number;
  height?: number;
  /** Modele giden nihai istem. */
  prompt: string;
  /** Kullanıcının yazdığı özgün istek. */
  userPrompt?: string;
  aspect: string;
  count: number;
  refs: JobRef[];
  entityIds: ID[];
  duration?: number;
  resolution?: string;
  quality?: string;
  /** Video: ilk kare olarak kullanılacak görsel. */
  startAssetId?: ID;
  /** Video: referanslardan önce bir anahtar kare üret. */
  keyframe?: boolean;
  keyframeModel?: string;
}

export interface Job {
  id: ID;
  type: JobType;
  status: JobStatus;
  provider: string;
  model: string;
  modelLabel: string;
  input: JobInput;
  assetIds: ID[];
  assets: Asset[];
  progress: number | null;
  stage: string | null;
  error: string | null;
  conversationId: ID | null;
  messageId: ID | null;
  postId: ID | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ───────────────────────── İçerik ─────────────────────────

export type PlatformId = 'instagram' | 'tiktok' | 'x' | 'linkedin' | 'facebook' | 'youtube';
export type PostStatus = 'idea' | 'draft' | 'scheduled' | 'published';

export interface Slide {
  headline: string;
  body: string;
}

export interface PostMetrics {
  reach?: number;
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  clicks?: number;
}

export interface PostData {
  /** Tasarım düzeninde görselin üzerine yazılacak kısa başlık. */
  headline?: string;
  subline?: string;
  /** Kaydırmalı gönderinin kareleri. */
  slides?: Slide[];
  /** Yayın sonrası elle girilen sonuçlar. */
  metrics?: PostMetrics;
}

export type ReviewStatus = 'pending' | 'approved' | 'changes';

export interface PostReview {
  token: string;
  status: ReviewStatus;
  reviewer: string;
  comment: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface Campaign {
  id: ID;
  brandId: ID | null;
  title: string;
  brief: string;
  platforms: PlatformId[];
  /** Görseller hazır olunca uygulanacak tasarım düzeni; boşsa uygulanmaz. */
  template: string;
  postCount: number;
  createdAt: string;
}

/** Onay sayfasında dışarıya açılan, gönderinin sınırlı görünümü. */
export interface ReviewView {
  review: PostReview;
  post: {
    title: string;
    platform: PlatformId;
    format: string;
    caption: string;
    hashtags: string[];
    scheduledAt: string | null;
    media: { url: string; kind: AssetKind }[];
  };
  brandName: string | null;
}

export interface Post {
  id: ID;
  brandId: ID | null;
  campaignId: ID | null;
  data: PostData;
  review: PostReview | null;
  title: string;
  platform: PlatformId;
  format: string;
  caption: string;
  hashtags: string[];
  assetIds: ID[];
  assets: Asset[];
  imagePrompt: string;
  status: PostStatus;
  scheduledAt: string | null;
  notes: string;
  designId: ID | null;
  conversationId: ID | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ───────────────────────── Tasarım ─────────────────────────

export interface LayerBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  hidden?: boolean;
  locked?: boolean;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  assetId: ID;
  fit: 'cover' | 'contain';
  /** Kırpma içinde odak noktası (0–1). */
  focusX: number;
  focusY: number;
  radius: number;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  font: string;
  size: number;
  weight: number;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
  uppercase: boolean;
  /** Metnin arkasındaki dolgu; boşsa yok. */
  background: string;
  padding: number;
  radius: number;
  shadow: boolean;
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: 'rect' | 'ellipse';
  fill: string;
  /** Verilirse fill → fill2 doğrusal geçiş çizilir. */
  fill2: string;
  angle: number;
  radius: number;
}

export type Layer = ImageLayer | TextLayer | ShapeLayer;

export interface DesignDoc {
  background: string;
  layers: Layer[];
}

export interface Design {
  id: ID;
  name: string;
  width: number;
  height: number;
  doc: DesignDoc;
  /** Son dışa aktarımın kütüphanedeki kaydı. */
  assetId: ID | null;
  thumbUrl: string | null;
  postId: ID | null;
  brandId: ID | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ───────────────────────── Sağlayıcılar ve ayarlar ─────────────────────────

export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'fal' | 'openai-compatible' | 'mock';
export type ModelKind = 'text' | 'image' | 'video';

export interface ModelOptions {
  /** fal: referans görsel verildiğinde kullanılacak uç nokta. */
  editEndpoint?: string;
  /** fal video: ilk kareden video. */
  imageEndpoint?: string;
  /** fal video: referans görsellerden video. */
  refEndpoint?: string;
  /** Her isteğe eklenecek ham parametreler. */
  extra?: Record<string, unknown>;
}

export interface ModelConfig {
  id: string;
  label: string;
  kind: ModelKind;
  /** Metin modeli görsel girdisi okuyabiliyor mu. */
  vision?: boolean;
  /** Tek istekte gönderilebilecek en fazla referans görsel. 0: desteklemiyor. */
  maxRefs?: number;
  /** Video: desteklenen süreler (sn). */
  durations?: number[];
  aspects?: string[];
  note?: string;
  enabled: boolean;
  custom?: boolean;
  options?: ModelOptions;
  /** Katalogdaki bilinen liste fiyatı; yoksa kullanıcı girer. */
  price?: ModelPrice;
}

/** ABD doları. Metin: 1 milyon belirteç başına; görsel: adet başına; video: saniye başına. */
export interface ModelPrice {
  input?: number;
  output?: number;
  unit?: number;
}

export interface BudgetSettings {
  /** Aylık tahmini harcama sınırı (USD); null ise sınır yok. */
  monthlyLimit: number | null;
  /** "saglayici:model" → kullanıcının girdiği fiyat. */
  prices: Record<string, ModelPrice>;
}

export interface UsageReport {
  rows: UsageRow[];
  /** Fiyatı bilinen kalemler için bu ayın tahmini harcaması. */
  monthSpend: number;
  /** Fiyatı girilmediği için hesaba katılamayan modeller. */
  unpriced: string[];
  budget: BudgetSettings;
  /** Geçerli fiyatlar (katalog + kullanıcı). */
  prices: Record<string, ModelPrice>;
}

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  name: string;
  description: string;
  baseUrl: string;
  enabled: boolean;
  builtin: boolean;
  hasKey: boolean;
  keyHint: string;
  needsKey: boolean;
  keyUrl: string;
  models: ModelConfig[];
}

export interface ModelRef {
  /** "saglayici:model" biçiminde tam kimlik. */
  ref: string;
  providerId: string;
  providerName: string;
  model: ModelConfig;
}

export interface Defaults {
  text: string | null;
  /** Başlık, hafıza özeti gibi küçük işler için hızlı model. */
  utility: string | null;
  image: string | null;
  video: string | null;
}

export interface BackupSettings {
  intervalHours: number;
  keep: number;
  mirrorDir: string;
}

export interface GenerationSettings {
  aspect: string;
  count: number;
  refsPerEntity: number;
  enhance: boolean;
  autoMemory: boolean;
  videoDuration: number;
}

export interface Settings {
  defaults: Defaults;
  backup: BackupSettings;
  generation: GenerationSettings;
  /** Her isteğe eklenen kalıcı yönerge (ör. "her zaman sen diye hitap et"). */
  customInstructions: string;
  budget: BudgetSettings;
  onboarded: boolean;
}

export interface MemorySuggestion {
  content: string;
  category: MemoryCategory;
}

export interface SpeechOption {
  provider: SpeechProvider;
  label: string;
  voices: { id: string; label: string }[];
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
  reason: string;
}

export interface BackupStatus {
  dataDir: string;
  dbSize: number;
  mediaSize: number;
  mediaCount: number;
  lastBackupAt: string | null;
  lastMirrorAt: string | null;
  mirrorDir: string;
  mirrorError: string | null;
  integrity: 'ok' | 'error' | 'unknown';
  backups: BackupFile[];
}

export interface Bootstrap {
  app: { name: string; version: string; dataDir: string; mock: boolean; ffmpeg: boolean; local: boolean; fal: boolean };
  settings: Settings;
  providers: ProviderInfo[];
  models: ModelRef[];
  entities: Entity[];
  conversations: Conversation[];
  counts: { assets: number; entities: number; memories: number; posts: number; trash: number };
  backup: { lastBackupAt: string | null; integrity: BackupStatus['integrity'] };
}

export interface UsageRow {
  day: string;
  provider: string;
  model: string;
  kind: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Görsel: adet. Video: saniye. */
  units: number;
  /** Fiyat biliniyorsa tahmini tutar (USD). */
  cost: number | null;
}

export interface TrashItem {
  kind: 'asset' | 'entity' | 'conversation' | 'post' | 'memory' | 'design';
  id: ID;
  title: string;
  thumbUrl: string | null;
  deletedAt: string;
}

export interface SearchResult {
  kind: 'conversation' | 'entity' | 'asset' | 'post' | 'memory';
  id: ID;
  title: string;
  subtitle: string;
  thumbUrl: string | null;
}

export interface NormalizedBox {
  /** Görsele göre 0–1 arası. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedPerson extends NormalizedBox {
  label: string;
  /** Kişinin görünen tüm gövdesi; `x,y,w,h` ise yüz ve omuzları alan portre kadrajıdır. */
  body?: NormalizedBox;
  /** Yüzün kendisi; arayüz işaretini buraya koyar. */
  face?: NormalizedBox;
}

export interface PeopleDetection {
  people: DetectedPerson[];
  /** local: bu bilgisayarda bulundu · model: yapay zekâ modeli buldu · none: otomatik bulma kullanılamıyor. */
  method: 'local' | 'model' | 'none';
}

export interface FalCatalogItem {
  endpointId: string;
  name: string;
  category: string;
  description: string;
  group: string;
  groupLabel: string;
  thumbnailUrl: string;
  date: string;
}

// ───────────────────────── Canlı olaylar (SSE) ─────────────────────────

export type ServerEvent =
  | { type: 'hello'; at: string }
  /** `offset`: parçanın bu ekten önceki uzunluğu. Ekler bu sayede sırasız ya da yinelenmiş gelse de doğru yere yazılır. */
  | { type: 'message.delta'; conversationId: ID; messageId: ID; partIndex: number; offset: number; text: string }
  | { type: 'message.pending'; conversationId: ID; messageId: ID; label: string | null }
  | { type: 'message.updated'; conversationId: ID; message: Message }
  | { type: 'job.updated'; job: Job }
  | { type: 'post.updated'; post: Post }
  | { type: 'conversation.updated'; conversation: Conversation }
  | { type: 'memory.changed' }
  | { type: 'entity.changed'; entityId: ID }
  | { type: 'asset.changed' }
  | { type: 'backup.done'; at: string };
