import { useEffect, useState } from 'react';
import type { PhotoMeta } from '../lib/metadata';

export function PhotoGrid({ photos }: { photos: PhotoMeta[] }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const created = photos.map((p) => URL.createObjectURL(p.file));
    setUrls(created);
    return () => created.forEach((u) => URL.revokeObjectURL(u));
  }, [photos]);

  return (
    <ul className="photo-grid">
      {photos.map((p, i) => (
        <li key={p.id}>
          {urls[i] && <img src={urls[i]} alt={p.name} loading="lazy" decoding="async" />}
          <span className="name">{p.name}</span>
          <span className="angles">
            {Math.round(p.yaw)}° / {Math.round(p.pitch)}°
          </span>
        </li>
      ))}
    </ul>
  );
}
