#!/usr/bin/env node
// Bellek'i çift tıklamayla açılan bir macOS uygulaması olarak kurar.
//
//   npm run app            → ~/Applications/Bellek.app
//   npm run app -- --dir <klasör> --port <port>
//
// Uygulama küçük bir başlatıcıdır: Bellek sunucusu çalışmıyorsa başlatır,
// hazır olunca tarayıcıda açar. Kod ve veriler olduğu yerde kalır; bu yüzden
// proje klasörünü taşırsanız komutu yeniden çalıştırmanız yeterlidir.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (process.platform !== 'darwin') {
  console.log('Başlatıcı şimdilik yalnızca macOS içindir. Bu sistemde Bellek\'i "npm start" ile açın.');
  process.exit(0);
}

const targetDir = path.resolve(option('dir', path.join(os.homedir(), 'Applications')));
const port = Number(option('port', '8787')) || 8787;
const app = path.join(targetDir, 'Bellek.app');
const tsx = path.join(project, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!fs.existsSync(tsx)) {
  console.error('Bağımlılıklar kurulu değil. Önce proje klasöründe "npm install" çalıştırın.');
  process.exit(1);
}

if (!fs.existsSync(path.join(project, 'dist', 'index.html'))) {
  console.log('Arayüz derleniyor…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: project, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('Arayüz derlenemedi; başlatıcı kurulmadı.');
    process.exit(1);
  }
}

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// Uygulamalar kabuğun PATH'ini devralmaz; bu yüzden node'un ve tsx'in tam yolu kurulum anında yazılır.
const launcher = `#!/bin/zsh
# Bellek başlatıcısı — scripts/install-app.mjs tarafından üretildi.
PROJECT=${quote(project)}
NODE=${quote(process.execPath)}
PORT=${port}
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/Bellek.log"

running() { /usr/bin/curl -fsS -o /dev/null --max-time 1 "$URL/api/auth"; }

if ! running; then
  if [[ ! -x "$NODE" || ! -f "$PROJECT/server/index.ts" ]]; then
    /usr/bin/osascript -e 'display alert "Bellek açılamadı" message "Proje klasörü ya da Node.js yerinde değil. Proje klasöründe \\"npm run app\\" komutunu yeniden çalıştırın."' >/dev/null
    exit 1
  fi
  cd "$PROJECT" || exit 1
  NODE_ENV=production PORT=$PORT nohup "$NODE" "$PROJECT/node_modules/tsx/dist/cli.mjs" server/index.ts >> "$LOG" 2>&1 &
  disown
  # İlk açılışta macOS, proje klasörüne (ör. Belgeler) erişim izni sorabilir; yanıtlanana kadar beklenir.
  for i in {1..360}; do
    running && break
    sleep 0.25
  done
  if ! running; then
    /usr/bin/osascript -e 'display alert "Bellek başlatılamadı" message "macOS klasör erişimi için izin sorduysa İzin Ver deyip uygulamayı yeniden açın. Ayrıntılar: ~/Library/Logs/Bellek.log"' >/dev/null
    exit 1
  fi
fi
/usr/bin/open "$URL"
`;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bellek</string>
  <key>CFBundleDisplayName</key><string>Bellek</string>
  <key>CFBundleIdentifier</key><string>local.bellek.baslatici</string>
  <key>CFBundleExecutable</key><string>Bellek</string>
  <key>CFBundleIconFile</key><string>Bellek</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

// Uygulama simgesi: arayüzdeki logonun macOS simge ızgarasına oturtulmuş hâli.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="186" fill="#171717"/>
  <circle cx="512" cy="512" r="193" fill="none" stroke="#F5852B" stroke-width="78"/>
  <circle cx="512" cy="512" r="67" fill="#FAFAFA"/>
</svg>`;

async function buildIcon(resources) {
  const { default: sharp } = await import('sharp');
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'bellek-')) + '/Bellek.iconset';
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const file = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      await sharp(Buffer.from(iconSvg)).resize(size * scale, size * scale).png().toFile(file);
    }
  }
  const result = spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Bellek.icns')]);
  fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist);
fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Bellek'), launcher, { mode: 0o755 });

try {
  await buildIcon(path.join(app, 'Contents', 'Resources'));
} catch (error) {
  console.warn(`Simge oluşturulamadı; uygulama varsayılan simgeyle kuruldu. (${error instanceof Error ? error.message.trim() : error})`);
}

// Finder'ın eski simgeyi önbellekten göstermemesi için.
spawnSync('/usr/bin/touch', [app]);

console.log(`Bellek kuruldu: ${app}`);
console.log(`Spotlight'ta "Bellek" yazarak ya da Uygulamalar klasöründen açın; Dock'a sürükleyebilirsiniz.`);
console.log(`Açıldığında http://127.0.0.1:${port} adresinde çalışır. Sunucuyu durdurmak için: npm run stop`);
console.log('İlk açılışta macOS proje klasörüne erişim izni sorabilir; "İzin Ver" deyin.');
