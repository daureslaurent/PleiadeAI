import { create } from 'zustand';
import { resetSocket } from '../lib/socket';

interface AuthState {
  token: string | null;
  setToken: (token: string) => void;
  logout: () => void;
}

/**
 * A JWT is only "authenticated" if it exists AND hasn't expired. The app gates the whole UI on
 * `token`, so a stale/expired token left in localStorage must read as null — otherwise the
 * workspace mounts, every request 401s, and the operator is stranded with no login window.
 */
function readValidToken(): string | null {
  const token = localStorage.getItem('pleiade_token');
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('malformed token');
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
      localStorage.removeItem('pleiade_token');
      return null;
    }
    return token;
  } catch {
    // Malformed token — treat as logged out rather than trusting it.
    localStorage.removeItem('pleiade_token');
    return null;
  }
}

export const useAuth = create<AuthState>((set) => ({
  token: readValidToken(),
  setToken: (token) => {
    localStorage.setItem('pleiade_token', token);
    resetSocket();
    set({ token });
  },
  logout: () => {
    localStorage.removeItem('pleiade_token');
    resetSocket();
    set({ token: null });
  },
}));
