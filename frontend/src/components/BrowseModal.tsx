/**
 * BrowseModal — two-panel DICOM study browser.
 *
 * Left panel:  patient/folder list under a configurable root path.
 * Right panel: all DICOM series in the selected folder, with key metadata.
 *
 * The user picks a series and clicks "Load Series" to push it into the
 * study store and close the modal.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listFolders, listSeries, loadSeries } from '../api/client';
import type { FolderEntry, SeriesInfo, StudyMeta } from '../api/types';

const DEFAULT_ROOT = '/Volumes/ROG STRIX/DICOM files CONTROLS';

interface Props {
  onLoaded: (study: StudyMeta) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function imageTypeTag(raw: string): string {
  // Highlight contrast vs non-contrast from ImageType field
  const upper = raw.toUpperCase();
  if (upper.includes('ORIGINAL') && upper.includes('PRIMARY')) return 'ORIG';
  if (upper.includes('DERIVED')) return 'DER';
  return raw.split('/')[0] ?? raw;
}

function thicknessLabel(t: number | null): string {
  return t != null ? `${t.toFixed(1)} mm` : '—';
}

function kvpLabel(k: number | null): string {
  return k != null ? `${k} kVp` : '—';
}

// Series that are clearly not the diagnostic CTA — dim them but keep visible
const LOW_VALUE_KEYWORDS = ['scout', 'dose', 'timing', 'bolus', 'report', 'localizer'];
function isLowValue(s: SeriesInfo): boolean {
  const d = s.description.toLowerCase();
  return LOW_VALUE_KEYWORDS.some((kw) => d.includes(kw)) || s.slice_count < 5;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BrowseModal: React.FC<Props> = ({ onLoaded, onClose }) => {
  const [rootPath, setRootPath] = useState(DEFAULT_ROOT);
  const [inputPath, setInputPath] = useState(DEFAULT_ROOT);

  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);

  const [selectedFolder, setSelectedFolder] = useState<FolderEntry | null>(null);
  const [series, setSeries] = useState<SeriesInfo[]>([]);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  const [selectedSeries, setSelectedSeries] = useState<SeriesInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Load folder list whenever rootPath changes
  const fetchFolders = useCallback(async (path: string) => {
    setLoadingFolders(true);
    setFolderError(null);
    setFolders([]);
    setSelectedFolder(null);
    setSeries([]);
    setSelectedSeries(null);
    try {
      const data = await listFolders(path);
      setFolders(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFolderError(msg.includes('404') ? `Path not found: ${path}` : msg);
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  useEffect(() => {
    void fetchFolders(rootPath);
  }, [rootPath, fetchFolders]);

  // When a folder is selected, fetch its series
  const handleSelectFolder = useCallback(async (folder: FolderEntry) => {
    setSelectedFolder(folder);
    setSeries([]);
    setSelectedSeries(null);
    setSeriesError(null);
    setLoadingSeries(true);
    try {
      const data = await listSeries(folder.path);
      setSeries(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSeriesError(msg);
    } finally {
      setLoadingSeries(false);
    }
  }, []);

  const handleLoad = useCallback(async () => {
    if (!selectedFolder || !selectedSeries) return;
    setLoading(true);
    setLoadError(null);
    try {
      const study = await loadSeries({
        path: selectedFolder.path,
        series_uid: selectedSeries.series_uid,
        folder_path: selectedSeries.folder_path,
      });
      onLoaded(study);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [selectedFolder, selectedSeries, onLoaded, onClose]);

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setRootPath(inputPath.trim());
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="browse-modal">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="browse-header">
          <span className="browse-title">Open DICOM Study</span>
          <button className="browse-close" onClick={onClose}>✕</button>
        </div>

        {/* ── Path bar ───────────────────────────────────────────────────── */}
        <form className="browse-pathbar" onSubmit={handlePathSubmit}>
          <input
            ref={inputRef}
            className="browse-path-input"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder="Enter folder path…"
            spellCheck={false}
          />
          <button type="submit" disabled={loadingFolders}>
            {loadingFolders ? '…' : 'Go'}
          </button>
        </form>

        {/* ── Two-panel body ─────────────────────────────────────────────── */}
        <div className="browse-body">

          {/* Left: folder list */}
          <div className="browse-folders">
            <div className="browse-panel-header">
              Patients / Folders
              <span className="browse-count">{folders.length}</span>
            </div>

            {folderError && <div className="browse-error">{folderError}</div>}

            <ul className="browse-list">
              {folders.map((f) => (
                <li
                  key={f.path}
                  className={[
                    'browse-folder-item',
                    !f.is_dicom_folder ? 'dimmed' : '',
                    selectedFolder?.path === f.path ? 'selected' : '',
                  ].join(' ')}
                  onClick={() => void handleSelectFolder(f)}
                  title={f.path}
                >
                  <span className="folder-icon">{f.is_dicom_folder ? '📂' : '📁'}</span>
                  {f.name}
                </li>
              ))}
              {!loadingFolders && folders.length === 0 && !folderError && (
                <li className="browse-empty">No subfolders found</li>
              )}
            </ul>
          </div>

          {/* Right: series table */}
          <div className="browse-series">
            <div className="browse-panel-header">
              {selectedFolder
                ? <>Series in <em>{selectedFolder.name}</em></>
                : 'Select a folder to see series'}
              {series.length > 0 && (
                <span className="browse-count">{series.length}</span>
              )}
            </div>

            {seriesError && <div className="browse-error">{seriesError}</div>}
            {loadingSeries && <div className="browse-loading">Scanning series…</div>}

            {series.length > 0 && (
              <table className="series-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Description</th>
                    <th>Slices</th>
                    <th>Thickness</th>
                    <th>kVp</th>
                    <th>Size</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr
                      key={s.series_uid}
                      className={[
                        'series-row',
                        isLowValue(s) ? 'series-dim' : '',
                        selectedSeries?.series_uid === s.series_uid ? 'selected' : '',
                      ].join(' ')}
                      onClick={() => setSelectedSeries(s)}
                    >
                      <td className="mono">{s.series_number}</td>
                      <td>{s.description}</td>
                      <td className="mono">{s.slice_count}</td>
                      <td className="mono">{thicknessLabel(s.slice_thickness_mm)}</td>
                      <td className="mono">{kvpLabel(s.kvp)}</td>
                      <td className="mono">{s.rows}×{s.cols}</td>
                      <td className="mono dimmed">{imageTypeTag(s.image_type)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {selectedFolder && !loadingSeries && series.length === 0 && !seriesError && (
              <div className="browse-empty">No DICOM series found in this folder</div>
            )}
          </div>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="browse-footer">
          {loadError && <span className="browse-error">{loadError}</span>}
          {selectedSeries && (
            <span className="browse-selection">
              Selected: <strong>{selectedSeries.description}</strong>
              {' '}({selectedSeries.slice_count} slices)
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!selectedSeries || loading}
            onClick={() => void handleLoad()}
          >
            {loading ? 'Loading…' : 'Load Series'}
          </button>
        </div>

      </div>
    </div>
  );
};

export default BrowseModal;
