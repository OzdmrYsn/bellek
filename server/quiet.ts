// node:sqlite, Node 22'de hâlâ "deneysel" uyarısı basıyor. API'nin kullandığımız
// kısmı kararlı; uyarıyı diğer uyarılara dokunmadan susturuyoruz. Bu modül,
// node:sqlite yüklenmeden önce çalışması için giriş dosyasında ilk sırada içe aktarılır.
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  if (typeof warning !== 'string' && warning?.name === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
