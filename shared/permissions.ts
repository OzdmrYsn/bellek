// Takım yetkileri. Sunucu her isteği bu anahtarlarla denetler; arayüz aynı
// listeden yetki anahtarlarını çizer ve yetkisi olmayan denetimleri gizler.

export const PERMISSION_GROUPS = [
  { id: 'studio', label: 'Stüdyo' },
  { id: 'memory', label: 'Hafıza' },
  { id: 'library', label: 'Kütüphane' },
  { id: 'content', label: 'İçerik' },
  { id: 'admin', label: 'Yönetim' },
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number]['id'];

export const PERMISSIONS = [
  {
    id: 'studio.generate', group: 'studio', label: 'Üretim yapabilir',
    description: 'Sohbet eder; görsel, video ve metin üretir. Her üretim API hesabınızdan harcar.',
  },
  {
    id: 'chats.viewAll', group: 'studio', label: 'Herkesin sohbetlerini görebilir',
    description: 'Kapalıyken yalnızca kendi sohbetlerini görür. Başkasının sohbetine yazamaz.',
  },
  {
    id: 'memory.edit', group: 'memory', label: 'Hafızaya ekleyip düzenleyebilir',
    description: 'Kişi, marka, ürün ve not ekler; var olanları değiştirir.',
  },
  {
    id: 'memory.delete', group: 'memory', label: 'Hafızadan silebilir',
    description: 'Kişileri, markaları ve notları çöp kutusuna taşır.',
  },
  {
    id: 'library.edit', group: 'library', label: 'Kütüphaneye yükleyip düzenleyebilir',
    description: 'Dosya yükler; başlık, etiket ve favorileri değiştirir.',
  },
  {
    id: 'library.delete', group: 'library', label: 'Kütüphaneden silebilir',
    description: 'Görsel ve videoları çöp kutusuna taşır.',
  },
  {
    id: 'content.edit', group: 'content', label: 'İçerik hazırlayabilir',
    description: 'Gönderi, kampanya ve tasarım oluşturur; takvimi düzenler.',
  },
  {
    id: 'content.delete', group: 'content', label: 'İçerik silebilir',
    description: 'Gönderi ve tasarımları çöp kutusuna taşır.',
  },
  {
    id: 'providers.view', group: 'admin', label: 'Bağlı yapay zekâları görebilir',
    description: 'Hangi sağlayıcıların ve modellerin bağlı olduğunu görür. Anahtarların tamamı kimseye gösterilmez.',
  },
  {
    id: 'providers.manage', group: 'admin', label: 'API anahtarlarını yönetebilir',
    description: 'Anahtar ekler, değiştirir, kaldırır; model açıp kapatır.',
  },
  {
    id: 'usage.view', group: 'admin', label: 'Kullanımı ve harcamayı görebilir',
    description: 'Model başına istek sayısını ve tahmini tutarı görür.',
  },
  {
    id: 'settings.manage', group: 'admin', label: 'Genel ayarları değiştirebilir',
    description: 'Varsayılan modeller, kalıcı yönerge, bütçe sınırı ve yedekleme sıklığı.',
  },
  {
    id: 'trash.manage', group: 'admin', label: 'Çöp kutusunu yönetebilir',
    description: 'Silinenleri geri getirir ya da kalıcı olarak siler.',
  },
  {
    id: 'data.manage', group: 'admin', label: 'Yedekleri ve veriyi yönetebilir',
    description: 'Yedek alır, eski bir yedeğe döner, tüm veriyi dışa ve içe aktarır.',
  },
  {
    id: 'team.manage', group: 'admin', label: 'Takımı yönetebilir',
    description: 'Üye ekler, yetki verir, hesap kapatır. Kendinde olmayan bir yetkiyi veremez.',
  },
] as const satisfies readonly { id: string; group: PermissionGroup; label: string; description: string }[];

export type Permission = (typeof PERMISSIONS)[number]['id'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.id);

/** Bir yetki açıldığında kendiliğinden açılması gerekenler. */
const IMPLIES: Partial<Record<Permission, Permission[]>> = {
  'providers.manage': ['providers.view'],
};

export type PresetId = 'admin' | 'editor' | 'viewer';

export const PRESETS: { id: PresetId; label: string; description: string; permissions: Permission[] }[] = [
  {
    id: 'admin', label: 'Yönetici',
    description: 'Her şeyi yapabilir: anahtarlar, yedekler ve takım dahil.',
    permissions: ALL_PERMISSIONS,
  },
  {
    id: 'editor', label: 'Editör',
    description: 'Üretir, yükler, içerik hazırlar. Hafızadan silemez; anahtarları ve harcamayı görmez.',
    permissions: ['studio.generate', 'memory.edit', 'library.edit', 'library.delete', 'content.edit', 'content.delete'],
  },
  {
    id: 'viewer', label: 'İzleyici',
    description: 'Hafızayı, kütüphaneyi ve içerikleri yalnızca görür.',
    permissions: [],
  },
];

/** Bilinmeyen anahtarları atar, yinelenenleri ayıklar, bağlı yetkileri ekler; sıra katalog sırasıdır. */
export function normalizePermissions(input: unknown): Permission[] {
  const given = new Set<string>(Array.isArray(input) ? input.map(String) : []);
  for (const [key, implied] of Object.entries(IMPLIES)) {
    if (given.has(key)) for (const item of implied ?? []) given.add(item);
  }
  return ALL_PERMISSIONS.filter((id) => given.has(id));
}

/** Yetki kümesi hazır bir role birebir uyuyorsa o rol, yoksa `custom`. */
export function presetOf(permissions: readonly string[]): PresetId | 'custom' {
  const key = normalizePermissions(permissions).join(',');
  return PRESETS.find((preset) => normalizePermissions(preset.permissions).join(',') === key)?.id ?? 'custom';
}

export function permissionLabel(id: Permission): string {
  return PERMISSIONS.find((p) => p.id === id)?.label ?? id;
}

/** Sahip her zaman her şeyi yapabilir; üyeler yalnızca kendilerine verilenleri. */
export function can(user: { role: string; permissions: readonly string[] } | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  return user.role === 'owner' || user.permissions.includes(permission);
}
