// Giriş noktası. node:sqlite uyarısı modül bağlanırken basıldığı için önce
// susturucu yüklenir, asıl uygulama ondan sonra içe aktarılır.
import './quiet.ts';

await import('./main.ts');
