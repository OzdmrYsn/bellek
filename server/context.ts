import { AsyncLocalStorage } from 'node:async_hooks';

// "Bu işi kim başlattı?" bilgisini fonksiyon imzalarına tek tek eklemeden taşır.
// Oturum kapısı her isteği o üyenin bağlamında çalıştırır; istek bittikten sonra
// süren işler (akan yanıt, kuyruktaki üretim) de aynı bağlamı korur. Harcama
// günlüğü ve yeni dosyalar sahibini buradan öğrenir.

const store = new AsyncLocalStorage<{ userId: string | null }>();

export function runAs<T>(userId: string | null, fn: () => T): T {
  return store.run({ userId }, fn);
}

export function currentUserId(): string | null {
  return store.getStore()?.userId ?? null;
}
