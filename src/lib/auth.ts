import { useQuery } from '@tanstack/react-query';
import { can, type Permission } from '../../shared/permissions.ts';
import type { AuthState, Me, Team, TeamMember } from '../../shared/types.ts';
import { api } from './api.ts';
import { queryClient, useApp } from './queries.ts';

export const authKey = ['auth'] as const;
export const teamKey = ['team'] as const;

export function useAuth() {
  return useQuery({ queryKey: authKey, queryFn: () => api.get<AuthState>('/api/auth'), retry: 2, staleTime: Infinity });
}

export function useMe(): Me {
  return useApp().me;
}

/** Oturumdaki kullanıcının yetkisi. Sunucu her isteği ayrıca denetler; bu yalnızca arayüzü sadeleştirir. */
export function useCan(permission: Permission): boolean {
  return can(useApp().me, permission);
}

export function useMember(id: string | null | undefined): TeamMember | undefined {
  const members = useApp().team.members;
  return id ? members.find((member) => member.id === id) : undefined;
}

export function useTeam() {
  return useQuery({ queryKey: teamKey, queryFn: () => api.get<Team>('/api/team') });
}

/** Giriş ya da kurulumdan sonra: önceki oturumdan kalan her şeyi at, yeni durumu yerleştir. */
export function adoptSession(state: AuthState): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
  queryClient.setQueryData(authKey, state);
}

export function setMe(me: Me): void {
  queryClient.setQueryData<AuthState>(authKey, (state) => (state ? { ...state, user: me } : state));
  void queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
  void queryClient.invalidateQueries({ queryKey: teamKey });
}

/** Çıkışta sayfa baştan yüklenir: bellekte önceki kullanıcıya ait hiçbir veri kalmaz. */
export async function signOut(): Promise<void> {
  try {
    await api.post('/api/auth/logout');
  } finally {
    window.location.assign('/');
  }
}

/** Yeni üye için okunabilir, rastgele bir şifre. */
export function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5, 10).join('')}-${chars.slice(10).join('')}`;
}
