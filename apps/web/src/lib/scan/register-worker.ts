/** Production only: in development a cached page would hide every code change. */
export async function registerScannerWorker() {
  if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register('/sw.js', { scope: '/scan' });
  const { active } = await navigator.serviceWorker.ready;
  const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
  active?.postMessage({ type: 'CACHE_URLS', urls });
}
