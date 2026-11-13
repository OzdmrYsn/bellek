import type { MessagePart } from '../../shared/types.ts';

// Akan yanıtların bellekteki güncel hâli. Veritabanına yazım aralıklı olduğu
// için, akış sırasında sohbeti açan ya da sayfayı yenileyen arayüz diskteki
// (biraz geride kalmış) kopyayı değil, buradaki canlı parçaları görür.
export const liveParts = new Map<string, MessagePart[]>();
