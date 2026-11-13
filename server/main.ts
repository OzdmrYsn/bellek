import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startBackupScheduler } from './backup.ts';
import { APP_NAME, DATA_DIR, DIST_DIR, HOST, IS_PROD, MOCK, PASSWORD, PORT } from './config.ts';
import { prepareLocalVision } from './media/people.ts';
import { closeDb, openDb } from './db.ts';
import { resumeJobs } from './jobs.ts';
import { ProviderError } from './providers/types.ts';
import { closeDanglingMessages } from './repo/chat.ts';
import { Invalid, NotFound } from './repo/entities.ts';
import { libraryRouter, mediaRouter } from './routes/library.ts';
import { entityRouter, memoryRouter } from './routes/memory.ts';
import {
  campaignRouter, conversationRouter, designRouter, generateRouter, jobRouter, messageRouter, postRouter,
  reviewRouter,
} from './routes/studio.ts';
import { systemRouter } from './routes/system.ts';
import { UploadError, clearTmp } from './storage.ts';

const opened = openDb();
closeDanglingMessages();
await clearTmp();

const app = express();
app.disable('x-powered-by');

// ───────────────────────── Güvenlik ─────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

function hostname(host: string | undefined): string {
  if (!host) return '';
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

app.use((req, res, next) => {
  // Yalnızca bu makineden erişime açıkken yabancı bir alan adı üzerinden gelen
  // istekleri (DNS yeniden bağlama) reddet.
  if (loopback && !LOCAL_HOSTS.has(hostname(req.headers.host))) {
    return res.status(403).json({ error: 'Bu adres üzerinden erişime izin verilmiyor.' });
  }
  // Başka bir sitenin, tarayıcı üzerinden bu sunucuya yazma isteği göndermesini engelle.
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== req.headers.host) {
      return res.status(403).json({ error: 'Kaynak doğrulanamadı.' });
    }
  }
  next();
});

app.use(express.json({ limit: '25mb' }));

const sessionToken = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('bellek-oturum-v1').digest('hex') : '';

function hasSession(req: Request): boolean {
  if (!PASSWORD) return true;
  const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('bellek_oturum='));
  const value = cookie?.slice('bellek_oturum='.length) ?? '';
  return value.length === sessionToken.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(sessionToken));
}

app.get('/api/auth', (req, res) => {
  res.json({ required: !!PASSWORD, ok: hasSession(req) });
});

app.post('/api/auth', (req, res) => {
  const given = String((req.body as { password?: string })?.password ?? '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!PASSWORD || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Parola yanlış.' });
  }
  res.setHeader('Set-Cookie', `bellek_oturum=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  res.json({ ok: true });
});

// Onay bağlantıları parola istemez: belirteç tek bir gönderiye erişim verir, başka hiçbir şeye.
app.use('/api/review', reviewRouter);

app.use(['/api', '/media'], (req, res, next) => {
  if (hasSession(req)) return next();
  res.status(401).json({ error: 'Oturum açmanız gerekiyor.' });
});

// ───────────────────────── Uçlar ─────────────────────────

app.use('/media', mediaRouter);
app.use('/api/assets', libraryRouter);
app.use('/api/entities', entityRouter);
app.use('/api/memories', memoryRouter);
app.use('/api/conversations', conversationRouter);
app.use('/api/messages', messageRouter);
app.use('/api/jobs', jobRouter);
app.use('/api/generate', generateRouter);
app.use('/api/posts', postRouter);
app.use('/api/campaigns', campaignRouter);
app.use('/api/designs', designRouter);
app.use('/api', systemRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Böyle bir uç yok.' });
});

if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(express.static(DIST_DIR, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile('index.html', { root: DIST_DIR, headers: { 'Cache-Control': 'no-cache' } });
  });
} else if (IS_PROD) {
  app.get('/', (_req, res) => {
    res.status(503).type('text/plain; charset=utf-8').send('Arayüz derlenmemiş. Önce "npm run build" çalıştırın.');
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const message = error instanceof Error ? error.message : 'Beklenmeyen bir hata oluştu.';
  if (error instanceof NotFound) return res.status(404).json({ error: message });
  if (error instanceof Invalid || error instanceof UploadError) return res.status(400).json({ error: message });
  if (error instanceof ProviderError) return res.status(422).json({ error: message });
  const anyError = error as { code?: string; type?: string; status?: number };
  if (anyError?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Dosya çok büyük (en fazla 2 GB).' });
  if (anyError?.type === 'entity.too.large') return res.status(413).json({ error: 'İstek çok büyük.' });
  if (anyError?.type === 'entity.parse.failed') return res.status(400).json({ error: 'İstek gövdesi okunamadı.' });
  if (anyError?.status === 404 || anyError?.code === 'ENOENT') return res.status(404).json({ error: 'Dosya bulunamadı.' });
  console.error('[sunucu]', error);
  res.status(500).json({ error: 'Sunucuda beklenmeyen bir hata oluştu. Ayrıntı için terminale bakın.' });
});

// ───────────────────────── Başlat ─────────────────────────

// Yerel kişi algılayıcısı ilk kullanımda derlenir; kullanıcı beklemesin diye arka planda hazırlanır.
void prepareLocalVision();

const server = app.listen(PORT, HOST, () => {
  const address = `http://${loopback ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  ${APP_NAME} çalışıyor`);
  console.log(`  Sunucu   ${address}`);
  if (!IS_PROD) console.log(`  Arayüz   http://localhost:${process.env.VITE_PORT || 5173}  (geliştirme)`);
  console.log(`  Veriler  ${DATA_DIR}`);
  if (opened.created) console.log('  Yeni bir hafıza oluşturuldu.');
  if (opened.migratedFrom !== null) console.log(`  Veritabanı güncellendi (sürüm ${opened.migratedFrom} → yeni); öncesi yedeklendi.`);
  if (MOCK) console.log('  Deneme sağlayıcısı açık (BELLEK_MOCK=1).');
  if (!loopback && !PASSWORD) console.log('  UYARI: Sunucu ağa açık ama parola yok. BELLEK_PASSWORD ayarlayın.');
  console.log('');
  startBackupScheduler();
  resumeJobs();
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  ${PORT} numaralı port kullanımda. Başka bir port deneyin: PORT=8788 npm run dev\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Açık SSE bağlantıları kapanışı bekletmesin.
  server.closeAllConnections?.();
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
