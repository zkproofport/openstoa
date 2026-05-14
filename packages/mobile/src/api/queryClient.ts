import { QueryClient } from '@tanstack/react-query';

/**
 * The single React-Query cache shared by every screen in the OpenStoa
 * mini-app. Exported from `api/` (not from `OpenStoaApp.tsx`) so that
 * non-React modules — notably `auth/sessionLifecycle.ts` — can clear it
 * on auth-boundary crossings without needing context.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
