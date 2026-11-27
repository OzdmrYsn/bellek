import type { Response } from 'express';
import type { ServerEvent } from '../shared/types.ts';

// Tek bir SSE kanalı: sohbet akışı, iş ilerlemesi ve veri değişiklikleri buradan
// yayınlanır. Sayfa yenilense ya da başka sayfaya geçilse de üretim sürer;
// arayüz yeniden bağlanıp kaldığı yerden devam eder.

interface Client {
  res: Response;
  userId: string;
  sessionId: string;
}

const clients = new Set<Client>();

/** Bir olayın belirli bir kullanıcıya gidip gitmeyeceğine karar verir (`access.ts` kurar). */
type Scope = (event: ServerEvent, userId: string) => boolean;
let scope: Scope = () => true;

export function setEventScope(next: Scope): void {
  scope = next;
}

export function subscribe(res: Response, userId: string, sessionId = ''): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 1500\n\n`);
  const client: Client = { res, userId, sessionId };
  clients.add(client);
  send(client, { type: 'hello', at: new Date().toISOString() });
  res.on('close', () => clients.delete(client));
}

function send(client: Client, event: ServerEvent): void {
  try {
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

export function emit(event: ServerEvent): void {
  for (const client of clients) {
    let allowed = false;
    try {
      allowed = scope(event, client.userId);
    } catch {
      allowed = false;
    }
    if (allowed) send(client, event);
  }
}

function drop(match: (client: Client) => boolean): void {
  for (const client of clients) {
    if (!match(client)) continue;
    clients.delete(client);
    try {
      client.res.end();
    } catch {
      // Bağlantı zaten kapanmış olabilir.
    }
  }
}

/** Hesabı kapatılan ya da silinen üyenin açık bağlantılarını keser. */
export function disconnectUser(userId: string): void {
  drop((client) => client.userId === userId);
}

/** Kapatılan oturumların bağlantılarını keser; `exceptSessionId` açık kalır. */
export function disconnectSessions(userId: string, exceptSessionId?: string): void {
  drop((client) => client.userId === userId && client.sessionId !== exceptSessionId);
}

export function disconnectSession(sessionId: string): void {
  drop((client) => client.sessionId === sessionId);
}

const heartbeat = setInterval(() => {
  for (const client of clients) {
    try {
      client.res.write(`: ping\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}, 20000);
heartbeat.unref();
