'use client';

import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { useEffect, useRef, useState } from 'react';

// The camera reads a code many times a second. The same code counts again only after leaving the frame
// for this long, which also lets a volunteer deliberately rescan.
const SAME_CODE_PAUSE_MS = 3_000;

export function Camera({ onScan }: { onScan: (qr: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let controls: IScannerControls | null = null;
    let stopped = false;
    let last = { text: '', at: 0 };

    new BrowserQRCodeReader()
      .decodeFromVideoDevice(undefined, video.current!, (decoded) => {
        if (!decoded) return;
        const text = decoded.getText();
        const now = Date.now();
        const repeat = text === last.text && now - last.at < SAME_CODE_PAUSE_MS;
        last = { text, at: now };
        if (!repeat) onScan(text);
      })
      .then(
        (started) => {
          if (stopped) started.stop();
          else controls = started;
        },
        () =>
          setProblem(
            'The camera is not available. Allow camera access (phones need HTTPS for this), or paste the code below.',
          ),
      );
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [onScan]);

  if (problem) return <p className="rounded-card bg-canvas p-4 text-sm text-muted">{problem}</p>;
  return (
    <video
      ref={video}
      muted
      playsInline
      aria-label="Camera view for scanning ticket QR codes"
      className="aspect-square w-full rounded-card bg-ink object-cover"
    />
  );
}
