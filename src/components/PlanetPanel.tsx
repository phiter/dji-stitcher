import { useEffect, useMemo, useRef, useState } from 'react';
import { exportImage } from '../lib/export';
import { ASPECTS, planetSizes, type Aspect } from '../lib/sizes';
import type { StitchSession } from '../lib/stitch';
import { ExportPanel } from './ExportPanel';

interface Props {
  session: StitchSession;
  fillSky: boolean;
  onFillSky: (value: boolean) => void;
}

const PREVIEW_SIZE: Record<Aspect, [number, number]> = {
  '1:1': [960, 960],
  '16:9': [1280, 720],
  '9:16': [540, 960],
};

export function PlanetPanel({ session, fillSky, onFillSky }: Props) {
  const [aspect, setAspect] = useState<Aspect>('1:1');
  const [fov, setFov] = useState(120);
  const [rotation, setRotation] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sizes = useMemo(() => planetSizes(session, aspect, fov), [session, aspect, fov]);

  useEffect(() => {
    const controller = new AbortController();
    const [width, height] = PREVIEW_SIZE[aspect];
    session.renderer
      .render({ width, height, projection: { kind: 'planet', fov, rotation }, fillSky, signal: controller.signal })
      .then((surface) => {
        const el = canvas.current;
        if (!el) return;
        el.width = width;
        el.height = height;
        el.getContext('2d')!.drawImage(surface, 0, 0);
        setError(null);
      })
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [session, aspect, fov, rotation, fillSky]);

  return (
    <div className="planet">
      <div className="planet-controls">
        <div className="segmented" role="group" aria-label="Aspect ratio">
          {ASPECTS.map((a) => (
            <button key={a} className={a === aspect ? 'active' : ''} onClick={() => setAspect(a)}>
              {a}
            </button>
          ))}
        </div>
        <label className="slider">
          Field of view
          <input type="range" min={90} max={170} value={fov} onChange={(e) => setFov(Number(e.target.value))} />
          <span>{fov}°</span>
        </label>
        <label className="slider">
          Rotation
          <input type="range" min={0} max={360} value={rotation} onChange={(e) => setRotation(Number(e.target.value))} />
          <span>{rotation}°</span>
        </label>
      </div>
      <canvas ref={canvas} className="planet-preview" />
      {error && <p className="error">{error}</p>}
      <ExportPanel
        sizes={sizes}
        jpegLabel="JPEG (high quality)"
        fillSky={fillSky}
        onFillSky={onFillSky}
        onExport={async (size, format, onStatus, signal) => ({
          blob: await exportImage(
            session,
            { size, format, fillSky, projection: { kind: 'planet', fov, rotation } },
            onStatus,
            signal,
          ),
          filename: `little-planet_${aspect.replace(':', 'x')}_${size.width}x${size.height}.${format === 'jpeg' ? 'jpg' : 'png'}`,
        })}
      />
    </div>
  );
}
