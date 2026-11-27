import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { ALL_PERMISSIONS } from '../../shared/permissions.ts';
import type { AuthState, InviteInfo, LoginInput, SetupInput } from '../../shared/types.ts';
import {
  Forbidden, assertLoginAllowed, burnPassword, clearLoginFailures, clearSessionCookie, clientIp, createSession,
  deleteSession, deleteSessionsOf, listSessions, passwordProblem, recordLoginFailure, setSessionCookie, verifyPassword,
} from '../auth.ts';
import { LOCAL_HOSTS, PASSWORD, hostOnly } from '../config.ts';
import { emit } from '../events.ts';
import { actorOf, identify } from '../middleware/auth.ts';
import { Invalid, NotFound } from '../repo/entities.ts';
import {
  adoptOrphanConversations, countUsers, createUser, findInvite, findLogin, getActor, getAvatar, logActivity, normalizeEmail,
  passwordHashOf, setAvatar, setTeamName, teamName, toMe, updateUser, type Actor,
} from '../repo/teams.ts';

/** Oturum gerektirmeyen uçlar: durum, ilk kurulum, giriş ve çıkış. */
export const publicAuthRouter = Router();
/** Oturum açmış kullanıcının kendi hesabı. */
export const accountRouter = Router();
export const avatarRouter = Router();

function setupMode(req: Request): AuthState['setupMode'] {
  if (PASSWORD) return 'code';
  const address = clientIp(req);
  const sameMachine = address === '127.0.0.1' || address === '::1';
  return sameMachine && LOCAL_HOSTS.has(hostOnly(req.headers.host)) ? 'open' : 'local-only';
}

function authState(req: Request, actor: Actor | undefined): AuthState {
  return { setup: countUsers() === 0, setupMode: setupMode(req), user: actor ? toMe(actor) : null, teamName: teamName() };
}

function signIn(req: Request, res: Response, actor: Actor): void {
  setSessionCookie(req, res, createSession(actor.id, req));
}

publicAuthRouter.get('/', identify, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(authState(req, req.actor));
});

let settingUp = false;

/** İlk hesap: takımı kurar ve sahibi olur. Yalnızca hiç hesap yokken çalışır. */
publicAuthRouter.post('/setup', async (req, res) => {
  const body = (req.body ?? {}) as Partial<SetupInput>;
  if (countUsers() > 0 || settingUp) throw new Invalid('Bu takım zaten kurulmuş. E-posta ve şifrenizle giriş yapın.');
  const mode = setupMode(req);
  if (mode === 'local-only') {
    throw new Forbidden('İlk hesap yalnızca Bellek\'in çalıştığı bilgisayardan (localhost) oluşturulabilir.');
  }
  if (mode === 'code') {
    const ip = clientIp(req);
    assertLoginAllowed(ip, 'kurulum');
    const given = crypto.createHash('sha256').update(String(body.code ?? '')).digest();
    const expected = crypto.createHash('sha256').update(PASSWORD).digest();
    if (!crypto.timingSafeEqual(given, expected)) {
      recordLoginFailure(ip, 'kurulum');
      throw new Invalid('Kurulum kodu yanlış.');
    }
  }
  const name = String(body.name ?? '').trim();
  if (!name) throw new Invalid('Adınızı yazın.');
  const problem = passwordProblem(body.password);
  if (problem) throw new Invalid(problem);

  settingUp = true;
  try {
    const actor = await createUser({
      email: String(body.email ?? ''), password: String(body.password), name, role: 'owner',
      permissions: ALL_PERMISSIONS, createdBy: null, onboarded: true,
    });
    setTeamName(String(body.teamName ?? '').trim() || `${name} takımı`);
    adoptOrphanConversations(actor.id);
    logActivity(actor, 'setup', 'Takımı kurdu.');
    signIn(req, res, actor);
    res.status(201).json(authState(req, actor));
  } finally {
    settingUp = false;
  }
});

publicAuthRouter.post('/login', async (req, res) => {
  const body = (req.body ?? {}) as Partial<LoginInput>;
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  if (!email || !password) throw new Invalid('E-posta ve şifrenizi yazın.');
  const ip = clientIp(req);
  assertLoginAllowed(ip, email);

  const found = findLogin(email);
  let ok = false;
  if (found) ok = await verifyPassword(password, found.passwordHash);
  else await burnPassword(password);
  if (!found || !ok) {
    recordLoginFailure(ip, email);
    // 401 değil: arayüz 401'i "oturum düştü" diye yorumlar.
    throw new Invalid('E-posta ya da şifre yanlış.');
  }
  if (found.actor.disabled) throw new Forbidden('Bu hesap kapatılmış. Takım yöneticinizle görüşün.');
  clearLoginFailures(ip, email);
  signIn(req, res, found.actor);
  logActivity(found.actor, 'login', 'Giriş yaptı.');
  res.json(authState(req, found.actor));
});

/** Davet bağlantısı: kimin, hangi takıma çağrıldığını gösterir. Giriş için yine şifre gerekir. */
publicAuthRouter.get('/invite/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const invite = findInvite(req.params.token);
  if (!invite) throw new NotFound('Bu davet bağlantısı artık geçerli değil. Hesabınız varsa e-posta ve şifrenizle giriş yapın.');
  const info: InviteInfo = { teamName: teamName(), email: invite.email, name: invite.name };
  res.json(info);
});

publicAuthRouter.post('/logout', identify, (req, res) => {
  if (req.sessionId) deleteSession(req.sessionId);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ───────────────────────── Hesabım ─────────────────────────

accountRouter.patch('/me', async (req, res) => {
  const actor = actorOf(req);
  const body = (req.body ?? {}) as { name?: string };
  const next = await updateUser(actor.id, { name: body.name !== undefined ? String(body.name) : undefined });
  emit({ type: 'team.changed' });
  res.json(toMe(next));
});

/**
 * İlk giriş adımı: üye adını yazar ve yöneticinin verdiği şifre yerine kendi şifresini koyar.
 * Şifresi sonradan sıfırlanan üye de buradan geçer; ondan yalnızca yeni şifre istenir.
 */
accountRouter.post('/me/complete', async (req, res) => {
  const actor = actorOf(req);
  const body = (req.body ?? {}) as { name?: string; password?: string };
  const name = String(body.name ?? '').trim();
  if (!actor.onboarded && !name) throw new Invalid('Adınızı yazın.');
  if (actor.mustChangePassword) {
    const problem = passwordProblem(body.password);
    if (problem) throw new Invalid(problem);
    if (await verifyPassword(String(body.password), passwordHashOf(actor.id))) {
      throw new Invalid('Yeni şifreniz size verilen şifreyle aynı olamaz.');
    }
  }
  const next = await updateUser(actor.id, {
    name: actor.onboarded ? undefined : name,
    onboarded: true,
    password: actor.mustChangePassword ? String(body.password) : undefined,
    mustChangePassword: false,
  });
  if (actor.mustChangePassword) {
    deleteSessionsOf(actor.id, req.sessionId);
    logActivity(next, 'password', 'Kendi şifresini belirledi.');
  }
  if (!actor.onboarded) logActivity(next, 'join', 'Takıma katıldı.');
  emit({ type: 'team.changed' });
  res.json(toMe(next));
});

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } }).single('file');

accountRouter.post('/me/avatar', (req, res, next) => {
  avatarUpload(req, res, (error: unknown) => {
    if (!error) return next();
    const code = (error as { code?: string }).code;
    next(new Invalid(code === 'LIMIT_FILE_SIZE' ? 'Profil resmi en fazla 8 MB olabilir.' : 'Profil resmi yüklenemedi.'));
  });
}, async (req, res) => {
  const actor = actorOf(req);
  if (!req.file) throw new Invalid('Bir görsel seçin.');
  let image: Buffer;
  try {
    image = await sharp(req.file.buffer, { animated: false })
      .rotate()
      .resize({ width: 256, height: 256, fit: 'cover', position: 'attention' })
      .webp({ quality: 84 })
      .toBuffer();
  } catch {
    throw new Invalid('Bu dosya bir görsel olarak okunamadı. JPG, PNG ya da WebP deneyin.');
  }
  setAvatar(actor.id, image);
  emit({ type: 'team.changed' });
  res.json(toMe(getActor(actor.id)!));
});

accountRouter.delete('/me/avatar', (req, res) => {
  const actor = actorOf(req);
  setAvatar(actor.id, null);
  emit({ type: 'team.changed' });
  res.json(toMe(getActor(actor.id)!));
});

accountRouter.post('/me/password', async (req, res) => {
  const actor = actorOf(req);
  const body = (req.body ?? {}) as { current?: string; next?: string };
  const ip = clientIp(req);
  assertLoginAllowed(ip, actor.email);
  if (!(await verifyPassword(String(body.current ?? ''), passwordHashOf(actor.id)))) {
    recordLoginFailure(ip, actor.email);
    throw new Invalid('Şimdiki şifreniz yanlış.');
  }
  const problem = passwordProblem(body.next);
  if (problem) throw new Invalid(problem);
  await updateUser(actor.id, { password: String(body.next), mustChangePassword: false });
  // Şifre değişince diğer cihazlardaki oturumlar kapanır; bu oturum açık kalır.
  deleteSessionsOf(actor.id, req.sessionId);
  logActivity(actor, 'password', 'Şifresini değiştirdi.');
  res.json({ ok: true });
});

accountRouter.get('/sessions', (req, res) => {
  res.json(listSessions(actorOf(req).id, req.sessionId));
});

accountRouter.post('/sessions/revoke-others', (req, res) => {
  const actor = actorOf(req);
  deleteSessionsOf(actor.id, req.sessionId);
  res.json(listSessions(actor.id, req.sessionId));
});

accountRouter.delete('/sessions/:id', (req, res) => {
  const actor = actorOf(req);
  deleteSession(req.params.id, actor.id);
  if (req.params.id === req.sessionId) clearSessionCookie(req, res);
  res.json(listSessions(actor.id, req.sessionId));
});

// ───────────────────────── Profil resimleri ─────────────────────────

avatarRouter.get('/:id', (req, res) => {
  const image = getAvatar(req.params.id);
  if (!image) throw new NotFound('Profil resmi yok.');
  // Adres resim değiştikçe değişir (?v=…); bu yüzden kalıcı olarak önbelleğe alınabilir.
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(Buffer.from(image));
});
