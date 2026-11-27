import type { NextFunction, Request, Response } from 'express';
import { can, permissionLabel, type Permission } from '../../shared/permissions.ts';
import { Forbidden, Unauthorized, readSessionCookie, resolveSession } from '../auth.ts';
import { runAs } from '../context.ts';
import { getActor, type Actor } from '../repo/teams.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Oturumu açmış kullanıcı; `authenticate` ya da `identify` yerleştirir. */
      actor?: Actor;
      sessionId?: string;
    }
  }
}

/** Çerezdeki oturum geçerliyse kullanıcıyı isteğe yerleştirir; değilse dokunmaz. */
export function identify(req: Request, _res: Response, next: NextFunction): void {
  const session = resolveSession(readSessionCookie(req));
  if (session) {
    const actor = getActor(session.userId);
    if (actor && !actor.disabled) {
      req.actor = actor;
      req.sessionId = session.sessionId;
    }
  }
  next();
}

/** Oturum yoksa 401 döner. Bu kapıdan sonraki her uçta `req.actor` vardır. */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  identify(req, res, () => {
    // Bundan sonraki her şey bu üyenin adına çalışır: harcama ve üretilen dosyalar ona yazılır.
    if (req.actor) return runAs(req.actor.id, next);
    res.status(401).json({ error: 'Oturum açmanız gerekiyor.' });
  });
}

/** Yalnızca `actor` alanına bakılır; böylece her türden istek nesnesiyle çalışır. */
type WithActor = { actor?: Actor };

/** Rota parametrelerinin tipini bozmayan kapı: `router.get('/:id', need(...), handler)` içinde `req.params.id` yine `string` kalır. */
type Guard = <P>(req: Request<P>, res: Response, next: NextFunction) => void;

export function actorOf(req: WithActor): Actor {
  if (!req.actor) throw new Unauthorized('Oturum açmanız gerekiyor.');
  return req.actor;
}

function deny(permission: Permission): Forbidden {
  return new Forbidden(`Bu işlem için yetkiniz yok (${permissionLabel(permission)}).`);
}

export function assertCan(req: WithActor, ...permissions: Permission[]): void {
  const actor = actorOf(req);
  for (const permission of permissions) if (!can(actor, permission)) throw deny(permission);
}

export function assertAny(req: WithActor, ...permissions: Permission[]): void {
  const actor = actorOf(req);
  if (!permissions.some((permission) => can(actor, permission))) throw deny(permissions[0]);
}

/** Sayılan yetkilerin hepsi gerekir. */
export function need(...permissions: Permission[]): Guard {
  return (req, _res, next) => {
    assertCan(req, ...permissions);
    next();
  };
}

/** Sayılan yetkilerden biri yeter. */
export function needAny(...permissions: Permission[]): Guard {
  return (req, _res, next) => {
    assertAny(req, ...permissions);
    next();
  };
}
