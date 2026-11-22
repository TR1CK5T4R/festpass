'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GateSetup } from '@/components/scan/gate-setup';
import { GateView } from '@/components/scan/gate-view';
import { useAuth } from '@/lib/auth';
import { registerScannerWorker } from '@/lib/scan/register-worker';
import { loadGateSettings, saveGate, type SavedGate } from '@/lib/scan/store';

const say = (text: string) => (
  <p className="p-4 text-sm text-muted" role="status">
    {text}
  </p>
);

/**
 * A saved gate opens straight away, whatever the auth state: with no network there is no way to refresh
 * the session, and the gate must still work. The API still decides everything at sync, and an expired
 * session only means "log in to sync". Choosing a gate is what needs a login.
 */
export default function ScanPage() {
  const auth = useAuth();
  const router = useRouter();
  const [settings, setSettings] = useState<{ gate: SavedGate | null; deviceId: string } | null>(
    null,
  );
  const [storageFailed, setStorageFailed] = useState(false);

  useEffect(() => {
    void registerScannerWorker();
    loadGateSettings().then(setSettings, () => setStorageFailed(true));
  }, []);

  const unknownVisitor = auth.status === 'anonymous' && !auth.unreachable;
  useEffect(() => {
    if (settings && !settings.gate && unknownVisitor) router.replace('/login?next=/scan');
  }, [router, settings, unknownVisitor]);

  if (storageFailed) return say('This browser cannot store scans here. Leave private browsing.');
  if (!settings) return say('Loading…');

  const choose = async (gate: SavedGate | null) => {
    await saveGate(gate);
    setSettings({ ...settings, gate });
  };

  if (settings.gate) {
    return (
      <GateView
        // A different gate starts with fresh timers and state.
        key={`${settings.gate.eventId} ${settings.gate.gateId}`}
        gate={settings.gate}
        deviceId={settings.deviceId}
        onChangeGate={() => void choose(null)}
      />
    );
  }
  if (auth.status === 'anonymous' && auth.unreachable) {
    return say('You are offline. Connect once to pick an event; after that this works offline.');
  }
  if (auth.status !== 'authenticated') return say('Loading…');
  return <GateSetup onOpen={(gate) => void choose(gate)} />;
}
