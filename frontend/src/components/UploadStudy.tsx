/**
 * UploadStudy — drag-and-drop / file / folder import modal.
 *
 * Folder flow:
 *   1. User clicks "Add Folder…" and picks a directory.
 *   2. DICOM files are scanned client-side (dicom-parser) to group into series.
 *   3. SeriesPickerModal shows series with contrast / phase info.
 *   4. User picks one series → only those files are uploaded.
 */

import React, {
  useCallback,
  useRef,
  useState,
  DragEvent,
  ChangeEvent,
} from 'react';
import { uploadFolder, axiosErrorMessage } from '../api/client';
import { scanDicomFiles } from '../lib/dicomScanner';
import type { ScannedSeries } from '../lib/dicomScanner';
import SeriesPickerModal from './SeriesPickerModal';
import type { StudyMeta } from '../api/types';
import type { UseStudyReturn } from '../hooks/useStudyTypes';

interface Props {
  studies: StudyMeta[];
  loading: boolean;
  currentStudy: StudyMeta | null;
  onUpload: UseStudyReturn['uploadStudy'];
  onAddStudy: UseStudyReturn['addStudy'];
  onSelect: UseStudyReturn['selectStudy'];
  onRemove: UseStudyReturn['removeStudy'];
  onClose: () => void;
}

const FILE_ACCEPT = '.zip,.dcm,.mhd,.nii,.nii.gz';
const FILE_ACCEPT_DISPLAY = '.zip, .dcm, .mhd, .nii, .nii.gz';

const UploadStudy: React.FC<Props> = ({
  studies,
  loading,
  currentStudy,
  onUpload,
  onAddStudy,
  onSelect,
  onRemove,
  onClose,
}) => {
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Folder scan / picker state
  const [scanning, setScanning] = useState(false);
  const [scannedSeries, setScannedSeries] = useState<ScannedSeries[] | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // ── Single file upload ──────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    setUploadError(null);
    try {
      await onUpload(file);
    } catch (err: unknown) {
      setUploadError(axiosErrorMessage(err));
    }
  }, [onUpload]);

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const preferred = files.find((f) => /\.(zip|dcm|mhd|nii|gz)$/i.test(f.name)) ?? files[0];
    if (preferred) void handleFile(preferred);
  }, [handleFile]);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = '';
  };

  // ── Folder scan ─────────────────────────────────────────────────────────
  const onFolderInputChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    // Snapshot BEFORE clearing — some browsers invalidate FileList in-place on reset
    const allFiles = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (allFiles.length === 0) return;

    setUploadError(null);
    setScanning(true);
    setScannedSeries(null);

    try {
      const series = await scanDicomFiles(allFiles);
      setScannedSeries(series);
    } catch (err: unknown) {
      setUploadError(axiosErrorMessage(err));
      setScanning(false);
    } finally {
      setScanning(false);
    }
  }, []);

  // ── Series selected from picker → upload only those files ───────────────
  const handleSeriesSelected = useCallback(async (series: ScannedSeries) => {
    setScannedSeries(null);
    setUploadError(null);
    setUploading(true);
    try {
      const study = await uploadFolder(series.files);
      onAddStudy(study);
      onClose();
    } catch (err: unknown) {
      setUploadError(axiosErrorMessage(err));
    } finally {
      setUploading(false);
    }
  }, [onAddStudy, onClose]);

  const busy = loading || uploading || scanning;

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-box" onClick={(e) => e.stopPropagation()}>
          <h2>Load DICOM Data</h2>

          {/* Drop zone */}
          <div
            className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
          >
            {busy ? (
              <>
                <span className="spinner" style={{ marginBottom: 6 }} />
                <div style={{ fontSize: 11, color: '#666' }}>
                  {scanning ? 'Scanning series…' : 'Uploading…'}
                </div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 4 }}>Drop files here or click to browse</div>
                <div style={{ fontSize: 10, color: '#555' }}>Supported: {FILE_ACCEPT_DISPLAY}</div>
              </>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={{ flex: 1 }} onClick={() => fileInputRef.current?.click()} disabled={busy}>
              Add File…
            </button>
            <button
              style={{ flex: 1 }}
              onClick={() => folderInputRef.current?.click()}
              disabled={busy}
              title="Scan folder — pick which series to load"
            >
              {scanning ? 'Scanning…' : uploading ? 'Uploading…' : 'Add Folder…'}
            </button>
          </div>

          {uploadError && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#c0392b' }}>{uploadError}</div>
          )}

          {/* Hidden inputs */}
          <input ref={fileInputRef} type="file" accept={FILE_ACCEPT} multiple style={{ display: 'none' }} onChange={onFileInputChange} />
          <input
            ref={folderInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={onFolderInputChange}
            // @ts-expect-error — webkitdirectory is non-standard but universally supported
            webkitdirectory=""
          />

          {/* Loaded studies list */}
          {studies.length > 0 && (
            <>
              <div style={{ marginTop: 14, marginBottom: 4, fontSize: 10, color: '#666' }}>Loaded studies</div>
              <ul className="study-list">
                {studies.map((s) => (
                  <li
                    key={s.uid}
                    className={currentStudy?.uid === s.uid ? 'selected' : ''}
                    onClick={() => { onSelect(s.uid); onClose(); }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.name || s.uid}
                      <span style={{ marginLeft: 6, color: '#555' }}>
                        [{s.shape[0]}×{s.shape[1]}×{s.shape[2]}]
                      </span>
                    </span>
                    <button
                      style={{ marginLeft: 8, padding: '1px 6px', fontSize: 10 }}
                      onClick={(e) => { e.stopPropagation(); void onRemove(s.uid); }}
                      title="Remove study"
                    >✕</button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>

      {/* Series picker — shown after folder scan completes */}
      {scannedSeries !== null && (
        <SeriesPickerModal
          series={scannedSeries}
          scanning={scanning}
          onSelect={handleSeriesSelected}
          onClose={() => setScannedSeries(null)}
        />
      )}
    </>
  );
};

export default UploadStudy;
