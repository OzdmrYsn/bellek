import { Router } from 'express';
import os from 'node:os';
import { PRESETS, can, normalizePermissions, presetOf, type Permission } from '../../shared/permissions.ts';
import type { MemberInput, MemberPatch, Team, TeamAccess, TeamMember } from '../../shared/types.ts';
import { forgetAccessCache } from '../access.ts';
import { Forbidden, deleteSessionsOf, passwordProblem } from '../auth.ts';
import { LOOPBACK, PORT } from '../config.ts';
import { disconnectUser, emit } from '../events.ts';
import { actorOf, need } from '../middleware/auth.ts';
import { Invalid, NotFound } from '../repo/entities.ts';
import {
  cleanLimit, createUser, deleteUser, getMember, listActivity, listMembers, logActivity, setTeamName, teamName, updateUser,
  type Actor,
} from '../repo/teams.ts';
import { query } from './library.ts';

/** `/api/team`: üyeler, yetkiler ve etkinlik günlüğü. */
export const teamsRouter = Router();

function access(): TeamAccess {
  if (LOOPBACK) return { local: true, urls: [] };
  const urls: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${PORT}`);
    }
  }
  return { local: false, urls };
}

function roleLabel(permissions: readonly Permission[]): string {
  const preset = presetOf(permissions);
  return preset === 'custom' ? 'özel yetkiler' : PRESETS.find((p) => p.id === preset)!.label;
}

/** Sahip dışındakiler yalnızca kendilerinde olan yetkileri verebilir. */
function assertGrantable(actor: Actor, permissions: Permission[]): void {
  if (actor.role === 'owner') return;
  if (permissions.some((permission) => !actor.permissions.includes(permission))) {
    throw new Forbidden('Kendinizde olmayan bir yetkiyi veremezsiniz.');
  }
}

/** Kim kimi değiştirebilir: sahibe dokunulmaz, kimse kendini yükseltemez, daha yetkili üye yönetilemez. */
function assertManageable(actor: Actor, target: TeamMember): void {
  if (target.role === 'owner') throw new Forbidden('Takım sahibinin hesabı buradan değiştirilemez.');
  if (target.id === actor.id) throw new Forbidden('Kendi hesabınızı buradan değiştiremezsiniz; Hesabım bölümünü kullanın.');
  if (actor.role !== 'owner' && (target.permissions ?? []).some((permission) => !actor.permissions.includes(permission))) {
    throw new Forbidden('Sizden fazla yetkisi olan bir üyeyi değiştiremezsiniz.');
  }
}

function changed(): void {
  forgetAccessCache();
  emit({ type: 'team.changed' });
}

teamsRouter.get('/', (req, res) => {
  const manager = can(actorOf(req), 'team.manage');
  const team: Team = { name: teamName(), members: listMembers(manager) };
  if (manager) team.access = access();
  res.json(team);
});

teamsRouter.patch('/', need('team.manage'), (req, res) => {
  const actor = actorOf(req);
  const name = setTeamName(String((req.body as { name?: string }).name ?? ''));
  logActivity(actor, 'team.rename', `Takımın adını “${name}” yaptı.`);
  changed();
  res.json({ name });
});

/** Yeni üye: e-posta ve şifreyi yönetici belirler; üye ilk girişte adını ve resmini kendi tamamlar. */
teamsRouter.post('/members', need('team.manage'), async (req, res) => {
  const actor = actorOf(req);
  const body = (req.body ?? {}) as Partial<MemberInput>;
  const problem = passwordProblem(body.password);
  if (problem) throw new Invalid(problem);
  const permissions = normalizePermissions(body.permissions);
  assertGrantable(actor, permissions);
  const created = await createUser({
    email: String(body.email ?? ''), password: String(body.password), name: body.name, role: 'member',
    permissions, createdBy: actor.id, onboarded: false, monthlyLimit: cleanLimit(body.monthlyLimit),
  });
  logActivity(actor, 'member.add', `${created.email} için hesap açtı (${roleLabel(permissions)}).`);
  changed();
  res.status(201).json(getMember(created.id));
});

teamsRouter.patch('/members/:id', need('team.manage'), async (req, res) => {
  const actor = actorOf(req);
  const target = getMember(req.params.id);
  if (!target) throw new NotFound('Üye bulunamadı.');
  assertManageable(actor, target);
  const body = (req.body ?? {}) as MemberPatch;
  const label = target.name || target.email || 'Üye';

  const permissions = body.permissions !== undefined ? normalizePermissions(body.permissions) : undefined;
  if (permissions) assertGrantable(actor, permissions);
  if (body.password !== undefined) {
    const problem = passwordProblem(body.password);
    if (problem) throw new Invalid(problem);
  }
  const monthlyLimit = body.monthlyLimit !== undefined ? cleanLimit(body.monthlyLimit) : undefined;
  await updateUser(target.id, {
    name: body.name !== undefined ? String(body.name) : undefined,
    email: body.email !== undefined ? String(body.email) : undefined,
    permissions,
    disabled: body.disabled,
    password: body.password,
    // Şifreyi yönetici belirlediyse üye bir sonraki girişte kendi şifresini koyar.
    mustChangePassword: body.password !== undefined ? true : undefined,
    monthlyLimit,
  });

  if (monthlyLimit !== undefined && monthlyLimit !== (target.monthlyLimit ?? null)) {
    logActivity(
      actor, 'member.limit',
      monthlyLimit === null ? `${label} üyesinin aylık harcama sınırını kaldırdı.` : `${label} üyesinin aylık harcama sınırını ${monthlyLimit.toFixed(2)} $ yaptı.`,
    );
  }

  if (permissions && permissions.join(',') !== (target.permissions ?? []).join(',')) {
    logActivity(actor, 'member.permissions', `${label} üyesinin yetkilerini değiştirdi (${roleLabel(permissions)}).`);
  }
  if (body.password !== undefined) {
    deleteSessionsOf(target.id);
    disconnectUser(target.id);
    logActivity(actor, 'member.password', `${label} üyesinin şifresini sıfırladı.`);
  }
  if (body.disabled !== undefined && body.disabled !== !!target.disabled) {
    if (body.disabled) {
      deleteSessionsOf(target.id);
      disconnectUser(target.id);
    }
    logActivity(actor, body.disabled ? 'member.disable' : 'member.enable', `${label} üyesinin hesabını ${body.disabled ? 'kapattı' : 'yeniden açtı'}.`);
  }
  changed();
  res.json(getMember(target.id));
});

teamsRouter.delete('/members/:id', need('team.manage'), (req, res) => {
  const actor = actorOf(req);
  const target = getMember(req.params.id);
  if (!target) throw new NotFound('Üye bulunamadı.');
  assertManageable(actor, target);
  deleteUser(target.id);
  disconnectUser(target.id);
  logActivity(actor, 'member.remove', `${target.name} (${target.email}) üyesini takımdan çıkardı.`);
  changed();
  res.json({ ok: true });
});

teamsRouter.get('/activity', need('team.manage'), (req, res) => {
  res.json(listActivity(Number(query(req, 'limit')) || 150));
});
