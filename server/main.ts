import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import './access.ts';
import { Forbidden, TooMany, Unauthorized, pruneSessions } from './auth.ts';
import { startBackupScheduler } from './backup.ts';
import {
  APP_NAME, DATA_DIR, DIST_DIR, HOST, IS_PROD, LOCAL_HOSTS, LOOPBACK, MOCK, PASSWORD, PORT, hostOnly,
} from './config.ts';
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
import { integrationsRouter } from './routes/integrations.ts';
import { teamsRouter } from './routes/teams.ts';
import { accountRouter, avatarRouter, publicAuthRouter } from './routes/auth.ts';
import { authenticate, need } from './middleware/auth.ts';
import { countUsers } from './repo/teams.ts';
import { UploadError, clearTmp } from './storage.ts';

const opened = openDb();
closeDanglingMessages();
pruneSessions();
await clearTmp();

const app = express();
app.disable('x-powered-by');

// ───────────────────────── Güvenlik ─────────────────────────

const loopback = LOOPBACK;

app.use((req, res, next) => {
  // Yalnızca bu makineden erişime açıkken yabancı bir alan adı üzerinden gelen
  // istekleri (DNS yeniden bağlama) reddet.
  if (loopback && !LOCAL_HOSTS.has(hostOnly(req.headers.host))) {
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

// Onay bağlantıları hesap istemez: belirteç tek bir gönderiye erişim verir, başka hiçbir şeye.
app.use('/api/review', reviewRouter);

// Durum, ilk kurulum, giriş ve çıkış oturumsuz çalışır; bundan sonraki her uç oturum ister.
app.use('/api/auth', publicAuthRouter);
app.use(['/api', '/media'], authenticate);

// Şifresini yönetici belirlemiş üye, kendi şifresini koyana kadar yalnızca hesap uçlarına erişir.
app.use(['/api', '/media'], (req, res, next) => {
  if (!req.actor?.mustChangePassword) return next();
  if (req.originalUrl.startsWith('/api/auth/') || req.originalUrl.startsWith('/api/avatars/')) return next();
  res.status(403).json({ error: 'Devam etmeden önce kendi şifrenizi belirleyin.' });
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
app.use('/api/integrations', need('settings.manage'), integrationsRouter);
app.use('/api/auth', accountRouter);
app.use('/api/avatars', avatarRouter);
app.use('/api/team', teamsRouter);
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
  if (error instanceof Unauthorized) return res.status(401).json({ error: message });
  if (error instanceof Forbidden) return res.status(403).json({ error: message });
  if (error instanceof TooMany) return res.status(429).json({ error: message });
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
  if (countUsers() === 0) {
    console.log('  Henüz hesap yok: tarayıcıda açıp takım sahibi hesabını oluşturun.');
    if (!loopback && !PASSWORD) console.log('  Sunucu ağa açık; ilk hesap yalnızca bu bilgisayardan (localhost) oluşturulabilir.');
  }
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
