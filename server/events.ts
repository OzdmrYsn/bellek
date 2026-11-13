import type { Response } from 'express';
import type { ServerEvent } from '../shared/types.ts';

// Tek bir SSE kanalı: sohbet akışı, iş ilerlemesi ve veri değişiklikleri buradan
// yayınlanır. Sayfa yenilense ya da başka sayfaya geçilse de üretim sürer;
// arayüz yeniden bağlanıp kaldığı yerden devam eder.

const clients = new Set<Response>();

export function subscribe(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 1500\n\n`);
  clients.add(res);
  send(res, { type: 'hello', at: new Date().toISOString() });
  res.on('close', () => clients.delete(res));
}

function send(res: Response, event: ServerEvent): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    clients.delete(res);
  }
}

export function emit(event: ServerEvent): void {
  for (const client of clients) send(client, event);
}

const heartbeat = setInterval(() => {
  for (const client of clients) {
    try {
      client.write(`: ping\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}, 20000);
heartbeat.unref();
