# Bellek

Hafızası olan yaratıcı stüdyo. Kişilerinizi, markalarınızı ve tercihlerinizi bir kez tanıtırsınız; sonra sohbette `@yasin`, `@acme` diye çağırıp görsel, video, metin ve sosyal medya gönderisi üretirsiniz. Bellek kendi başına model çalıştırmaz: sizin API anahtarlarınızla, sizin seçtiğiniz yapay zekâlara bağlanır.

## Çalıştırma

Node.js 22.13 ya da üstü gerekir.

```bash
npm install
npm run dev        # geliştirme: http://localhost:5173
```

Günlük kullanım için derlenmiş sürüm tek adresten çalışır:

```bash
npm run build
npm start          # http://localhost:8787
```

İlk açılışta **Ayarlar → Yapay zekâlar** bölümünden en az bir anahtar ekleyin. Tek bir Google anahtarı metin, görsel ve videonun üçünü de açar; diğerlerini istediğiniz zaman eklersiniz.

### Masaüstü uygulaması (macOS)

```bash
npm run app        # ~/Applications/Bellek.app kurar
```

Bellek'i Spotlight'tan ya da Uygulamalar klasöründen çift tıklayarak açarsınız; Dock'a sürükleyebilirsiniz. Uygulama küçük bir başlatıcıdır: sunucu çalışmıyorsa başlatır, hazır olunca tarayıcıda açar. İlk açılışta macOS, proje klasörüne (ör. Belgeler) erişim izni sorabilir; bir kez **İzin Ver** demeniz yeterlidir. Sunucu arka planda çalışmayı sürdürür; durdurmak için `npm run stop`. Günlük `~/Library/Logs/Bellek.log` dosyasındadır. Proje klasörünü taşırsanız `npm run app` komutunu yeniden çalıştırın; kaldırmak için uygulamayı çöpe atmanız yeterlidir.

## Neler var

- **Stüdyo** — Sohbet. `@` yazınca hafızadaki kişi ve markalar listelenir; anılanların referans fotoğrafları ve bilgileri isteğe eklenir. Kipler: Otomatik, Metin, Görsel, Video, Gönderi. Görsel kipinde birden fazla model seçip aynı istemi yan yana karşılaştırabilirsiniz.
- **Boyut** — Üç yol: oran (1:1, 4:5, 9:16…), hazır boyut (Instagram gönderi, hikâye, X, LinkedIn, YouTube kapak, web afişi, A4…) ya da **Özel** sekmesinde kendi piksel ölçünüz (64–8192 px). Modeller yalnızca belirli oranlarda üretir; Bellek en yakın oranda ürettirir ve çıktıyı tam istediğiniz ölçüye getirir.
- **Hafıza** — Kişi, marka, ürün, stil ve mekân kayıtları; her birinin referans görselleri, görünüm profili ve notları. Markalarda renk paleti, yazı tipleri ve ses tonu; **Web sitesinden çek** ile logo, renkler, yazı tipleri ve tanıtım metni sitenizden okunur. Serbest notlar: “bundan sonra…” dediğinizde Bellek kendisi not alır; **Favorilerden öğren** kalp verdiğiniz görsellerden zevkinizi çıkarır.
- **Kütüphane** — Yüklediğiniz ve ürettiğiniz her şey. Görselleri seçip kişiye dönüştürün. **Kişileri seç** ile bir fotoğraftaki kişileri tıklayarak, kutu çizerek ya da çevresini serbestçe çizerek seçer, her birini yeni ya da var olan bir kişiye atarsınız; kalabalık fotoğrafta hepsi tek seferde kaydedilir. Tıklama macOS'ta bilgisayarın kendi algılayıcısıyla, anahtarsız çalışır (Xcode komut satırı araçları kuruluysa); değilse bağlı yapay zekâ modeline sorulur. Görsel araçları: **Bölge düzenle** (değişecek yeri fırçayla boyayın, gerisi piksel piksel aynı kalır), **Arka planı sil**, **Büyüt (2×)**. Her araç yeni bir görsel üretir; özgün dosya durur.
- **Montaj** — Kütüphanede birkaç video ya da görsel seçip tek videoda birleştirin; seslendirme, altyazı ve logolu kapanış ekleyin. `ffmpeg` gerekir.
- **İçerik ve Takvim** — Gönderi taslakları, platform önizlemesi, metin yeniden yazma ve etiket önerisi; sürükle-bırak takvim; tarih aralığı için yapay zekâyla içerik planı.
  - **Kampanya paketi** — Tek briften her platforma, o platformun diline ve görsel ölçüsüne uygun ayrı bir gönderi. Bir tasarım düzeni seçerseniz görseller hazır olunca başlık, gerçek logonuz ve marka renkleriniz üzerine yerleştirilir.
  - **Kaydırmalı gönderi** — Kareleri yapay zekâ yazar ya da siz yazarsınız; marka renkleri ve yazı tipiyle görsele çevrilir.
  - **Onay bağlantısı** — Müşteriniz gönderiyi hesap açmadan görür, onaylar ya da düzeltme ister.
  - **Yayın sonuçları** — Erişim, beğeni, kaydetme gibi sayıları girin; **İçgörü çıkar** neyin işe yaradığını hafızaya not olarak önerir.
- **Tasarım** — Katmanlı editör: üretilen görselin üzerine gerçek logonuzu, tam renk kodlarınızı ve hatasız metni yerleştirip PNG olarak dışa aktarırsınız. Tuval hazır boyutlardan ya da özel piksel ölçüsünden açılır.
- **Bütçe** — Ayarlar → Kullanım: bu ayın tahmini harcaması, model başına döküm ve birim fiyatlar. Aylık sınır verirseniz, sınıra ulaşılınca yeni üretimler durur.

## Verileriniz

Her şey bu bilgisayarda durur; veri klasörü bilerek proje klasörünün dışındadır, kodu silmek ya da güncellemek hafızaya dokunmaz.

| Sistem | Konum |
| --- | --- |
| macOS | `~/Library/Application Support/Bellek` |
| Windows | `%APPDATA%\Bellek` |
| Linux | `~/.local/share/bellek` |

İçinde `bellek.db` (SQLite), `media/` (görseller ve videolar), `backups/` (anlık kopyalar) ve `secrets.json` (API anahtarları) bulunur.

Veri kaybına karşı katmanlar:

1. Veritabanı WAL kipinde ve tam eşzamanlamayla yazılır; onaylanan kayıt diske inmiştir.
2. Medya dosyaları içeriğine göre adlandırılır ve bir kez yazılır; üzerine yazılmaz.
3. Silinen her şey önce çöp kutusuna gider (Ayarlar → Çöp kutusu).
4. Veritabanının anlık kopyası açılışta ve varsayılan olarak 6 saatte bir alınır; istediğiniz kopyaya dönebilirsiniz.
5. **Ayna klasör** (Ayarlar → Veri ve yedekleme): her yedekte veritabanı ve tüm medya ikinci bir konuma eşitlenir. Disk arızasına karşı asıl koruma budur; harici disk ya da iCloud Drive / Dropbox klasörü verin.
6. Tümünü ZIP olarak dışa aktarıp başka bir makinede içe aktarabilirsiniz. Anahtarlar arşive girmez.

## Sağlayıcılar

| Sağlayıcı | Metin | Görsel | Video |
| --- | --- | --- | --- |
| Anthropic (Claude) | ✓ | | |
| OpenAI | ✓ | ✓ | |
| Google (Gemini, Nano Banana, Omni) | ✓ | ✓ | ✓ |
| fal.ai (Kling, Seedance, FLUX, Seedream…) | | ✓ | ✓ |
| OpenRouter, xAI (Grok), DeepSeek, Mistral, Groq, Ollama (yerel) | ✓ | | |
| Başka herhangi bir OpenAI uyumlu uç nokta | ✓ | | |

Hazır katalogda 60'tan fazla model vardır; liste bir başlangıçtır. Her sağlayıcıda **Modelleri getir** ile hesabınızın güncel listesini çekebilir, kimliği elle de yazabilirsiniz (hazır listesi olmayan sağlayıcılarda anahtarı kaydedince liste kendiliğinden açılır). fal.ai için canlı katalogdan model eklersiniz; Bellek modelin girdi şemasını okuyup referans, oran ve süre alanlarını kendisi eşler.

Seslendirme OpenAI ya da Gemini anahtarınızla, macOS'ta ayrıca bilgisayarın yerleşik sesiyle yapılır. Arka plan silme ve bölge düzenleme bağlı görsel modelinizi kullanır; 2× büyütme anahtarsız, bu bilgisayarda çalışır.

## Ortam değişkenleri

| Değişken | Anlamı |
| --- | --- |
| `PORT` | Sunucu portu (varsayılan 8787) |
| `HOST` | Dinlenecek adres (varsayılan `127.0.0.1`). Ağda paylaşmak için `0.0.0.0` |
| `BELLEK_PASSWORD` | Verilirse arayüz ve API bu parolayla korunur. Ağa açarken mutlaka verin |
| `BELLEK_DATA_DIR` | Veri klasörünü başka bir yere taşır |
| `BELLEK_MOCK=1` | Anahtarsız deneme sağlayıcısını açar; sahte çıktılarla tüm akışı sınamak içindir |

## Onay bağlantısını paylaşmak

Onay bağlantıları Bellek'in kendi sunucusundan açılır. Varsayılan kurulumda Bellek yalnızca bu bilgisayarı dinler; bağlantı da yalnızca bu bilgisayarda çalışır. Başkasına göndermek için iki yol var:

- **Aynı ağdaki biri:** Bellek'i `HOST=0.0.0.0 BELLEK_PASSWORD=<parola> npm start` ile başlatın ve bağlantıdaki `127.0.0.1` yerine bilgisayarınızın ağ adresini yazın.
- **İnternetteki biri:** Bellek'i bir tünelle (Cloudflare Tunnel, Tailscale Funnel, ngrok) dışarı açın ve bağlantının başındaki adresi tünel adresiyle değiştirin. Parolayı mutlaka verin.

Parola stüdyoyu korur; onay sayfası bilerek parolasızdır, çünkü müşterinizin hesabı yoktur. Bağlantıdaki uzun anahtar yalnızca o tek gönderiyi ve görsellerini açar, tahmin edilemez ve **Bağlantıyı kapat** ile anında geçersiz olur.

## Bilinen sınırlar

- Bellek gönderileri yayınlamaz; neyin ne zaman çıkacağını tutar. Platformlara doğrudan yayın, her platformda sizin adınıza onaylanmış bir geliştirici uygulaması gerektirir.
- Kişiye özel model eğitimi (LoRA) yoktur; kişi tutarlılığı referans fotoğraflarla sağlanır.
- Bütçe tutarları tahmindir: Bellek üzerinden yapılan çağrılar, birim fiyatlarla çarpılır. Kesin fatura sağlayıcının panelindedir.
- Video önizleme kareleri için `ffmpeg` kuruluysa kullanılır; yoksa videolar önizlemesiz listelenir. HEIC fotoğraflar macOS'ta yüklenirken JPEG'e çevrilir.
- Sağlayıcıların içerik kuralları geçerlidir; gerçek kişilerin görüntülerini yalnızca izinleriyle kullanın.

## Geliştirme

```bash
npm run typecheck                  # arayüz ve sunucu için tip denetimi
BELLEK_MOCK=1 BELLEK_DATA_DIR=/tmp/bellek-deneme npm run dev   # anahtarsız, ayrı veriyle deneme
```

- `server/` — Express sunucusu, SQLite (`node:sqlite`), üretim kuyruğu, sağlayıcı bağdaştırıcıları (`server/providers/`), sohbet yönetmeni (`server/ai/`).
- `src/` — React arayüzü.
- `shared/` — iki tarafın ortak tipleri.
