import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DetectedPerson } from '../../shared/types.ts';
import { DATA_DIR } from '../config.ts';

// Fotoğraftaki kişileri bu bilgisayarda bulur (macOS, Apple Vision). Anahtar
// ve ağ gerektirmez. Küçük Swift aracı ilk kullanımda bir kez derlenir ve veri
// klasöründe saklanır; derleyici yoksa ya da sistem macOS değilse sessizce
// devre dışı kalır ve çağıran taraf yapay zekâ modeline düşer.

const run = promisify(execFile);
const SOURCE = fileURLToPath(new URL('./people.swift', import.meta.url));

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

interface Raw {
  faces: Box[];
  poses: Box[];
  bodies: Box[];
}

let building: Promise<string | null> | null = null;

async function build(): Promise<string | null> {
  if (process.platform !== 'darwin' || !fs.existsSync(SOURCE)) return null;
  // /usr/bin/swiftc geliştirici araçları kurulu değilken de vardır ve çağrılınca
  // kurulum penceresi açar; önce araçların gerçekten kurulu olduğuna bakılır.
  try {
    const { stdout } = await run('/usr/bin/xcode-select', ['-p'], { timeout: 5000 });
    if (!stdout.trim() || !fs.existsSync(stdout.trim())) return null;
  } catch {
    return null;
  }
  const source = await fsp.readFile(SOURCE);
  const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
  const dir = path.join(DATA_DIR, 'bin');
  const bin = path.join(dir, `people-${hash}-${process.arch}`);
  if (fs.existsSync(bin)) return bin;
  await fsp.mkdir(dir, { recursive: true });
  const draft = `${bin}.${process.pid}.tmp`;
  try {
    await run('/usr/bin/swiftc', ['-O', SOURCE, '-o', draft], { timeout: 240000 });
    await fsp.rename(draft, bin);
  } finally {
    await fsp.rm(draft, { force: true });
  }
  // Kaynağı değişmiş eski derlemeler birikmesin.
  for (const name of await fsp.readdir(dir)) {
    if (name.startsWith('people-') && path.join(dir, name) !== bin) await fsp.rm(path.join(dir, name), { force: true });
  }
  return bin;
}

/** Aracı hazırlar; kullanılamıyorsa null döner. Sonuç süreç boyunca hatırlanır. */
export function prepareLocalVision(): Promise<string | null> {
  building ??= build().catch(() => null);
  return building;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

function iou(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const inside = (px: number, py: number, b: { x: number; y: number; w: number; h: number }) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;

function rect(left: number, top: number, right: number, bottom: number): { x: number; y: number; w: number; h: number } {
  const x = clamp(left);
  const y = clamp(top);
  return { x, y, w: clamp(right) - x, h: clamp(bottom) - y };
}

/**
 * Ham algılamalardan kişi kutuları kurar. Her kişi için iki kadraj döner:
 * `x,y,w,h` yüz ve omuzları alan portre, `body` ise görünen tüm gövde.
 * `aspect`: görselin genişlik / yükseklik oranı (kutular 0–1 olduğu için gerekir).
 */
export function assemblePeople(raw: Raw, aspect: number): DetectedPerson[] {
  // Parçalı taramadan gelen yinelenen yüzleri ayıkla.
  const faces: Box[] = [];
  for (const face of [...raw.faces].sort((a, b) => b.confidence - a.confidence || b.w * b.h - a.w * a.h)) {
    if (face.confidence < 0.3 || face.w < 0.008 || face.h < 0.008) continue;
    if (!faces.some((kept) => iou(kept, face) > 0.3 || inside(face.x + face.w / 2, face.y + face.h / 2, kept))) faces.push(face);
  }

  const usedPoses = new Set<number>();
  const people: (DetectedPerson & { cx: number })[] = [];

  for (const face of faces) {
    const cx = face.x + face.w / 2;
    const cy = face.y + face.h / 2;
    // Yüz kutusu görselin oranına göre düzeltilir ki kadraj her yönde tutarlı olsun.
    const fw = Math.max(face.w, face.h / aspect);
    const fh = Math.max(face.h, face.w * aspect);
    // Baş ve omuzlar: kimlik referansı için yüz kadrajın büyük kısmını doldurmalı, komşular az girmeli.
    const portrait = rect(cx - fw * 1.4, face.y - fh * 0.7, cx + fw * 1.4, face.y + face.h + fh * 1.9);

    // Bu yüzün sahibi olan duruş: yüz merkezini içeren ve yatayda en yakın olan.
    let best = -1;
    let bestDistance = Infinity;
    raw.poses.forEach((pose, index) => {
      if (usedPoses.has(index)) return;
      const padded = { x: pose.x - pose.w * 0.25, y: pose.y - fh * 1.2, w: pose.w * 1.5, h: pose.h + fh * 1.2 };
      if (!inside(cx, cy, padded) || cy > pose.y + pose.h * 0.5) return;
      const distance = Math.abs(pose.x + pose.w / 2 - cx);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });

    let body: DetectedPerson['body'];
    if (best >= 0) {
      usedPoses.add(best);
      const pose = raw.poses[best];
      const padX = Math.max(pose.w * 0.14, fw * 0.5);
      body = rect(Math.min(pose.x - padX, cx - fw * 1.3), face.y - fh * 0.75, Math.max(pose.x + pose.w + padX, cx + fw * 1.3), pose.y + pose.h + pose.h * 0.07);
    } else {
      const human = raw.bodies.find((item) => item.confidence >= 0.4 && inside(cx, cy, item));
      body = human
        ? rect(Math.min(human.x, cx - fw * 1.3), Math.min(human.y, face.y - fh * 0.75), Math.max(human.x + human.w, cx + fw * 1.3), human.y + human.h)
        : rect(cx - fw * 2.2, face.y - fh * 0.75, cx + fw * 2.2, face.y + face.h + fh * 6.5);
    }
    // Gövde, portreden kısa kalmasın (ör. yalnızca omuzlara kadar görünen kişi).
    if (body.h < portrait.h) body = rect(Math.min(body.x, portrait.x), body.y, Math.max(body.x + body.w, portrait.x + portrait.w), portrait.y + portrait.h);
    people.push({ label: '', ...portrait, body, face: { x: face.x, y: face.y, w: face.w, h: face.h }, cx });
  }

  // Yüzü görünmeyen (arkası dönük, uzakta) kişiler: hiçbir yüzle eşleşmemiş, güvenilir duruşlar.
  raw.poses.forEach((pose, index) => {
    if (usedPoses.has(index) || pose.confidence < 9) return;
    if (faces.some((face) => inside(face.x + face.w / 2, face.y + face.h / 2, pose))) return;
    const padX = pose.w * 0.16;
    const body = rect(pose.x - padX, pose.y - pose.h * 0.14, pose.x + pose.w + padX, pose.y + pose.h * 1.06);
    if (people.some((person) => person.body && iou({ ...person.body, confidence: 0 }, { ...body, confidence: 0 }) > 0.45)) return;
    const portraitHeight = Math.min(body.h, body.w * aspect * 1.3);
    people.push({ label: '', x: body.x, y: body.y, w: body.w, h: portraitHeight, body, cx: body.x + body.w / 2 });
  });

  return people
    .filter((person) => person.w > 0.01 && person.h > 0.01)
    .sort((a, b) => a.cx - b.cx)
    .map(({ cx: _cx, ...person }, index) => ({ ...person, label: `Kişi ${index + 1}` }));
}

/**
 * Görseldeki kişileri yerel olarak bulur. Yerel algılama bu sistemde
 * kullanılamıyorsa ya da dosya okunamadıysa null döner.
 */
export async function detectPeopleLocal(file: string, width: number | null, height: number | null): Promise<DetectedPerson[] | null> {
  const bin = await prepareLocalVision();
  if (!bin) return null;
  try {
    const { stdout } = await run(bin, [file], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const raw = JSON.parse(stdout) as Raw;
    return assemblePeople(raw, width && height ? width / height : 1);
  } catch {
    return null;
  }
}
