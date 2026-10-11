import { useRef, useState } from 'react';
import { downloadBlob, type ExportStatus } from '../lib/export';
import type { ExportFormat } from '../lib/render/encode';
import type { SizeOption } from '../lib/sizes';

interface Props {
  sizes: SizeOption[];
  jpegLabel: string;
  fillSky: boolean;
  onFillSky: (value: boolean) => void;
  /** Renders and encodes the image; the panel downloads the returned file. */
  onExport: (
    size: SizeOption,
    format: ExportFormat,
    onStatus: (s: ExportStatus) => void,
    signal: AbortSignal,
  ) => Promise<{ blob: Blob; filename: string }>;
}

const megapixels = (s: SizeOption) => `${Math.round((s.width * s.height) / 1e6)} MP`;

export function ExportPanel({ sizes, jpegLabel, fillSky, onFillSky, onExport }: Props) {
  const [key, setKey] = useState('max');
  const [format, setFormat] = useState<ExportFormat>('jpeg');
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The selection falls back to maximum detail when the options change (e.g. another aspect ratio).
  const size = sizes.find((s) => s.key === key) ?? sizes.find((s) => s.key === 'max') ?? sizes[sizes.length - 1];

  const run = async () => {
    setError(null);
    setStatus({ label: 'Rendering', fraction: 0 });
    abort.current = new AbortController();
    try {
      const { blob, filename } = await onExport(size, format, setStatus, abort.current.signal);
      downloadBlob(blob, filename);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStatus(null);
    }
  };

  return (
    <div className="export">
      <label>
        Size
        <select value={size.key} onChange={(e) => setKey(e.target.value)} disabled={!!status}>
          {sizes.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label ? `${s.label} – ` : ''}
              {s.width} × {s.height} ({megapixels(s)})
            </option>
          ))}
        </select>
      </label>
      <label>
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} disabled={!!status}>
          <option value="jpeg">{jpegLabel}</option>
          <option value="png">PNG (lossless, large)</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={fillSky} onChange={(e) => onFillSky(e.target.checked)} disabled={!!status} />
        Fill empty sky and ground beyond the photos
      </label>
      {status ? (
        <div className="progress-row">
          <progress value={status.fraction} max={1} />
          <span>{status.label}…</span>
          <button className="secondary" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="primary" onClick={run}>
          Render &amp; download
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
