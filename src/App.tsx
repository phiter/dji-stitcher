import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExportPanel } from './components/ExportPanel';
import { PanoViewer } from './components/PanoViewer';
import { PhotoGrid } from './components/PhotoGrid';
import { PhotoPicker } from './components/PhotoPicker';
import { PlanetPanel } from './components/PlanetPanel';
import { exportImage } from './lib/export';
import { readAllMeta, type PhotoMeta, type RejectedFile } from './lib/metadata';
import { surfaceToBlob } from './lib/render/encode';
import { analyzeSelection } from './lib/selection';
import { panoramaSizes } from './lib/sizes';
import { stitchPhotos, type StitchSession } from './lib/stitch';

const MIN_PHOTOS = 6;

type View = 'panorama' | 'planet';

interface Busy {
  label: string;
  progress: number;
}

export default function App() {
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [session, setSession] = useState<StitchSession | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('panorama');
  const [fillSky, setFillSky] = useState(true);

  useEffect(() => () => session?.renderer.dispose(), [session]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const onFiles = useCallback(async (files: File[]) => {
    setError(null);
    setSession(null);
    setPreviewUrl(null);
    const { photos, rejected } = await readAllMeta(files);
    setPhotos(photos);
    setRejected(rejected);
    if (photos.length === 0) setError('None of the selected files are DJI photos with gimbal data.');
  }, []);

  const stitch = async () => {
    setError(null);
    setBusy({ label: 'Reading photos', progress: 0 });
    try {
      const result = await stitchPhotos(photos, (label, progress) => setBusy({ label, progress }));
      const blob = await surfaceToBlob(result.preview, 'jpeg', 0.92);
      setPreviewUrl(URL.createObjectURL(blob));
      setSession(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const model = photos.find((p) => p.model)?.model;
  const selection = useMemo(() => (photos.length ? analyzeSelection(photos) : null), [photos]);
  const canStitch = photos.length >= MIN_PHOTOS && !busy;
  const stats = session?.alignment.stats;
  const sizes = useMemo(() => (session ? panoramaSizes(session) : []), [session]);

  return (
    <div className="app">
      <header>
        <h1>Drone 360 Panorama Stitcher</h1>
        <p className="muted">
          Stitches the sphere panorama photos of a DJI drone into a full-resolution 360° panorama or a little planet.
          Everything runs in your browser; photos never leave your device.
        </p>
      </header>

      {photos.length === 0 && <PhotoPicker onFiles={onFiles} />}

      {error && <p className="error">{error}</p>}
      {rejected.length > 0 && (
        <p className="warning">
          Ignored {rejected.length} file{rejected.length > 1 ? 's' : ''}:{' '}
          {rejected.map((r) => `${r.name} (${r.reason})`).join('; ')}
        </p>
      )}

      {photos.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <strong>{photos.length} photos</strong>
              {model && <span className="muted"> · DJI {model}</span>}
              {selection && (
                <span className="muted"> · covers {Math.round(selection.coverage * 100)}% of the sphere</span>
              )}
              {photos.length < MIN_PHOTOS && (
                <p className="warning">Select all photos of the panorama (at least {MIN_PHOTOS}).</p>
              )}
              {selection?.warnings.map((w) => (
                <p key={w} className="warning">
                  {w}
                </p>
              ))}
            </div>
            <div className="actions">
              <PhotoPicker onFiles={onFiles} disabled={!!busy} compact />
              <button className="primary" disabled={!canStitch} onClick={stitch}>
                {session ? 'Stitch again' : 'Stitch panorama'}
              </button>
            </div>
          </div>
          {busy && (
            <div className="progress-row">
              <progress value={busy.progress} max={1} />
              <span>{busy.label}…</span>
            </div>
          )}
          {!session && <PhotoGrid photos={photos} />}
        </section>
      )}

      {session && previewUrl && (
        <section className="card">
          <div className="segmented" role="tablist">
            <button className={view === 'panorama' ? 'active' : ''} onClick={() => setView('panorama')}>
              360° panorama
            </button>
            <button className={view === 'planet' ? 'active' : ''} onClick={() => setView('planet')}>
              Little planet
            </button>
          </div>
          {view === 'panorama' ? (
            <>
              <PanoViewer url={previewUrl} />
              {session.alignment.warnings.map((w) => (
                <p key={w} className="warning">
                  {w}
                </p>
              ))}
              {stats && (
                <p className="muted small">
                  Aligned {photos.length} photos using {stats.matches.toLocaleString()} feature matches (
                  {stats.rmsPx.toFixed(2)} px RMS). Focal length {session.focalPx.toFixed(0)} px.
                </p>
              )}
              <ExportPanel
                sizes={sizes}
                jpegLabel="JPEG (high quality, 360° tagged)"
                fillSky={fillSky}
                onFillSky={setFillSky}
                onExport={async (size, format, onStatus, signal) => ({
                  blob: await exportImage(session, { size, format, fillSky, projection: { kind: 'equirect' } }, onStatus, signal),
                  filename: `panorama_${size.width}x${size.height}.${format === 'jpeg' ? 'jpg' : 'png'}`,
                })}
              />
            </>
          ) : (
            <PlanetPanel session={session} fillSky={fillSky} onFillSky={setFillSky} />
          )}
          <details>
            <summary>Source photos</summary>
            <PhotoGrid photos={photos} />
          </details>
        </section>
      )}
    </div>
  );
}
