'use client';

import type { EventView } from '@festpass/shared';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/form-errors';
import { uploadBanner } from '@/lib/upload';

interface BannerUploaderProps {
  event: EventView;
  canEdit: boolean;
  onChange: (event: EventView) => void;
}

export function BannerUploader({ event, canEdit, onChange }: BannerUploaderProps) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function upload(file: File) {
    setError(null);
    // Show the chosen image right away from memory; the real URL replaces it once the API confirms.
    const local = URL.createObjectURL(file);
    setPreview(local);
    setProgress(0);
    try {
      onChange(await uploadBanner(event.orgId, event.id, file, setProgress));
      toast('Banner updated');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
      setPreview(null);
      URL.revokeObjectURL(local);
      if (input.current) input.current.value = ''; // so choosing the same file again fires onChange
    }
  }

  async function remove() {
    setError(null);
    try {
      const res = await api.request<{ event: EventView }>(
        `/orgs/${event.orgId}/events/${event.id}`,
        { method: 'PATCH', body: { bannerKey: null } },
      );
      onChange(res.event);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const src = preview ?? event.bannerUrl;
  const uploading = progress !== null;

  return (
    <Card>
      <h2 className="mb-4 font-semibold">Banner</h2>
      <div className="relative aspect-[3/1] overflow-hidden rounded-control border border-line bg-canvas">
        {src ? (
          // A plain <img>: the storage host differs per environment, and next/image would need
          // each one allow-listed. Public pages (Day 10) get the optimized version.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={`Banner for ${event.title}`}
            className={`size-full object-cover ${uploading ? 'opacity-60' : ''}`}
          />
        ) : (
          <p className="flex size-full items-center justify-center text-sm text-muted">
            No banner yet. 3:1 works best, e.g. 1500 × 500.
          </p>
        )}
      </div>

      {uploading && (
        <div className="mt-3">
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 overflow-hidden rounded-full bg-line"
          >
            <div
              className="h-full bg-brand-600 transition-[width]"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Checking the file…'}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      {canEdit && (
        <div className="mt-4 flex items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            id="banner-file"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button variant="secondary" disabled={uploading} onClick={() => input.current?.click()}>
            {event.bannerUrl ? 'Replace banner' : 'Upload banner'}
          </Button>
          {event.bannerUrl && !uploading && (
            <Button variant="ghost" onClick={() => void remove()}>
              Remove
            </Button>
          )}
          <span className="text-xs text-muted">JPEG, PNG or WebP, up to 2 MB.</span>
        </div>
      )}
    </Card>
  );
}
