import { useRef, useState, type DragEvent } from 'react';

interface Props {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  compact?: boolean;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => (entry as FileSystemFileEntry).file((f) => resolve([f]), reject));
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const files: File[] = [];
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    for (const child of batch) files.push(...(await walk(child)));
  }
  return files;
}

async function filesFromDrop(e: DragEvent): Promise<File[]> {
  // Entries must be grabbed synchronously, before the first await.
  const entries = Array.from(e.dataTransfer.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  if (entries.length === 0) return Array.from(e.dataTransfer.files);
  return (await Promise.all(entries.map(walk))).flat();
}

export function PhotoPicker({ onFiles, disabled, compact }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    onFiles(await filesFromDrop(e));
  };

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${compact ? ' compact' : ''}${disabled ? ' disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        accept="image/jpeg"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
      {compact ? (
        <button className="secondary" disabled={disabled} onClick={() => input.current?.click()}>
          Choose different photos
        </button>
      ) : (
        <>
          <p className="drop-title">Drop all photos of one DJI sphere panorama here</p>
          <p className="muted">or drop their folder</p>
          <button className="primary" disabled={disabled} onClick={() => input.current?.click()}>
            Select photos
          </button>
        </>
      )}
    </div>
  );
}
