/**
 * Where to go after login or register: the `next` path a page sent the user from (e.g. a booking), or
 * the dashboard. Only same-site paths are accepted: "//evil.example" or "https://..." would turn the
 * login page into an open redirect, sending a freshly logged-in user to someone else's site.
 */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/dashboard';
  }
  return next;
}
