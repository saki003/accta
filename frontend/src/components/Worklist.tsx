import React, { useEffect, useState } from 'react';
import type { StudyMeta } from '../api/types';
import { useStudy } from '../hooks/useStudy';
import { getWorkspace, setWorkspace, axiosErrorMessage, listFolders, makeFolder, type WorkspaceInfo } from '../api/client';
import type { FolderEntry } from '../api/types';
import BrowseModal from './BrowseModal';
import UploadStudy from './UploadStudy';

type StudyStatus = 'unread' | 'in-progress' | 'complete';

const STATUS_COLOR: Record<StudyStatus, string> = {
  unread:        '#555',
  'in-progress': '#f5a623',
  complete:      '#6eb04b',
};
const STATUS_LABEL: Record<StudyStatus, string> = {
  unread:        'Unread',
  'in-progress': 'In Progress',
  complete:      'Complete',
};

function loadStatuses(): Record<string, StudyStatus> {
  try { return JSON.parse(localStorage.getItem('accta-study-statuses') ?? '{}'); }
  catch { return {}; }
}
function saveStatuses(s: Record<string, StudyStatus>) {
  localStorage.setItem('accta-study-statuses', JSON.stringify(s));
}

interface ParsedName {
  patientKey: string;   // "LastName_FirstName_YYYYMMDD" — grouping key
  last: string;
  first: string;
  date: string;         // formatted "YYYY-MM-DD"
  series: string;       // everything after " — "
}

function parseName(name: string): ParsedName {
  const sep = name.indexOf(' — ');
  const patientKey = sep >= 0 ? name.slice(0, sep) : name;
  const series = sep >= 0 ? name.slice(sep + 3) : '';
  const parts = patientKey.split('_');
  const last  = parts[0] ?? '';
  const first = parts[1] ?? '';
  const raw   = parts[2] ?? '';
  const date  = raw.length === 8
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
  return { patientKey, last, first, date, series };
}

interface PatientGroup {
  patientKey: string;
  displayName: string;  // "Last, First"
  date: string;
  studies: StudyMeta[];
}

function groupByPatient(studies: StudyMeta[]): PatientGroup[] {
  const map = new Map<string, PatientGroup>();
  for (const s of studies) {
    const { patientKey, last, first, date } = parseName(s.name || s.uid);
    if (!map.has(patientKey)) {
      const displayName = [last, first].filter(Boolean).join(', ') || patientKey;
      map.set(patientKey, { patientKey, displayName, date, studies: [] });
    }
    map.get(patientKey)!.studies.push(s);
  }
  return Array.from(map.values());
}

interface Props {
  onOpen: (study: StudyMeta) => void;
}

const Worklist: React.FC<Props> = ({ onOpen }) => {
  const { studies, loading, uploadStudy, addStudy, removeStudy, loadStudies } = useStudy();
  const [statuses, setStatuses] = useState<Record<string, StudyStatus>>(loadStatuses);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showBrowse, setShowBrowse] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [workspace, setWorkspaceState] = useState<WorkspaceInfo | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<StudyMeta | null>(null);

  useEffect(() => {
    void getWorkspace().then(setWorkspaceState).catch(() => {});
  }, []);

  useEffect(() => { void loadStudies(); }, [loadStudies]);

  const handleOpen = (study: StudyMeta) => {
    const updated = { ...statuses, [study.uid]: 'in-progress' as StudyStatus };
    setStatuses(updated);
    saveStatuses(updated);
    onOpen(study);
  };

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const groups = groupByPatient(studies);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#111', color: '#eee' }}>

      {/* Header */}
      <div style={{
        background: '#1a1a1a', borderBottom: '2px solid #0d0d0d',
        height: 52, display: 'flex', alignItems: 'center',
        padding: '0 24px', gap: 12, flexShrink: 0,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#e0e0e0', letterSpacing: '0.04em' }}>accta</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowBrowse(true)} disabled={loading}>
          {loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '📂 Browse'}
        </button>
        <button onClick={() => setShowUpload(true)} title="Upload DICOM file, folder, or ZIP">
          ↑ Upload
        </button>
        <button
          onClick={() => setShowSettings(true)}
          title={workspace ? `Workspace: ${workspace.data_dir}` : 'Workspace settings'}
        >
          ⚙
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: '#555',
          letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 16,
        }}>
          Patient Worklist
          {groups.length > 0 && ` · ${groups.length} patient${groups.length === 1 ? '' : 's'}, ${studies.length} series`}
        </div>

        {groups.length === 0 ? (
          <div style={{ color: '#444', fontSize: 14, textAlign: 'center', marginTop: 100, lineHeight: 2 }}>
            No studies loaded.<br />
            Use <strong style={{ color: '#666' }}>Browse</strong> to open from disk or{' '}
            <strong style={{ color: '#666' }}>Upload</strong> to import a file.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#444', textAlign: 'left', borderBottom: '1px solid #1e1e1e' }}>
                <th style={{ padding: '5px 12px', fontWeight: 500 }}>Series</th>
                <th style={{ padding: '5px 12px', fontWeight: 500 }}>Date</th>
                <th style={{ padding: '5px 12px', fontWeight: 500 }}>Slices</th>
                <th style={{ padding: '5px 12px', fontWeight: 500 }}>Spacing (mm)</th>
                <th style={{ padding: '5px 12px', fontWeight: 500 }}>Status</th>
                <th style={{ padding: '5px 12px', fontWeight: 500 }} />
              </tr>
            </thead>
            <tbody>
              {groups.map(group => {
                const isCollapsed = collapsed.has(group.patientKey);
                return (
                  <React.Fragment key={group.patientKey}>
                    {/* Patient header row */}
                    <tr
                      onClick={() => toggleCollapse(group.patientKey)}
                      style={{ cursor: 'pointer', background: '#161616', borderTop: '1px solid #222' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#1c1c1c')}
                      onMouseLeave={e => (e.currentTarget.style.background = '#161616')}
                    >
                      <td colSpan={6} style={{ padding: '9px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#555', fontSize: 10, width: 10 }}>
                            {isCollapsed ? '▶' : '▼'}
                          </span>
                          <span style={{ color: '#ddd', fontWeight: 600, fontSize: 13 }}>
                            {group.displayName}
                          </span>
                          {group.date && (
                            <span style={{ color: '#555', fontSize: 11, fontFamily: 'monospace' }}>
                              {group.date}
                            </span>
                          )}
                          <span style={{ color: '#3a3a3a', fontSize: 11, marginLeft: 4 }}>
                            {group.studies.length} series
                          </span>
                        </div>
                      </td>
                    </tr>

                    {/* Series rows */}
                    {!isCollapsed && group.studies.map(s => {
                      const { series } = parseName(s.name || s.uid);
                      const status = statuses[s.uid] ?? 'unread';
                      return (
                        <tr
                          key={s.uid}
                          style={{ borderBottom: '1px solid #181818' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#141414')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <td style={{ padding: '10px 12px 10px 30px', color: '#aaa' }}>
                            {series || <span style={{ color: '#444' }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#666', fontFamily: 'monospace', fontSize: 12 }}>
                            {parseName(s.name || s.uid).date || '—'}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#666', fontFamily: 'monospace' }}>
                            {s.shape[0]}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#666', fontFamily: 'monospace', fontSize: 12 }}>
                            {s.spacing.map(v => v.toFixed(3)).join(' × ')}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{
                                color: STATUS_COLOR[status], fontSize: 11, fontWeight: 600,
                                background: `${STATUS_COLOR[status]}18`,
                                padding: '2px 8px', borderRadius: 10,
                              }}>
                                {STATUS_LABEL[status]}
                              </span>
                              {s.extracted_vessels && s.extracted_vessels.length > 0 && (
                                <span
                                  title={`Centrelines extracted: ${s.extracted_vessels.join(', ')}`}
                                  style={{
                                    color: '#4ade80', fontSize: 11, fontWeight: 600,
                                    background: '#14532d33',
                                    padding: '2px 8px', borderRadius: 10,
                                  }}
                                >
                                  ✓ {s.extracted_vessels.length} vessel{s.extracted_vessels.length === 1 ? '' : 's'}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => handleOpen(s)}
                                style={{
                                  background: '#2563eb', border: 'none', borderRadius: 4,
                                  color: '#fff', padding: '5px 16px', cursor: 'pointer',
                                  fontSize: 12, fontWeight: 600,
                                }}
                              >
                                Open →
                              </button>
                              <button
                                onClick={() => setConfirmRemove(s)}
                                style={{
                                  background: 'transparent', border: '1px solid #2a2a2a',
                                  borderRadius: 4, color: '#555', padding: '5px 10px',
                                  cursor: 'pointer', fontSize: 12,
                                }}
                                title="Remove series"
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showBrowse && (
        <BrowseModal
          onLoaded={s => { addStudy(s); setShowBrowse(false); }}
          onClose={() => setShowBrowse(false)}
        />
      )}
      {showUpload && (
        <UploadStudy
          studies={studies}
          loading={loading}
          currentStudy={null}
          onUpload={uploadStudy}
          onAddStudy={addStudy}
          onSelect={() => {}}
          onRemove={removeStudy}
          onClose={() => setShowUpload(false)}
        />
      )}
      {showSettings && (
        <WorkspaceSettings
          info={workspace}
          onClose={() => setShowSettings(false)}
          onSaved={info => setWorkspaceState(info)}
        />
      )}
      {confirmRemove && (
        <ConfirmRemove
          study={confirmRemove}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={async () => {
            const target = confirmRemove;
            setConfirmRemove(null);
            await removeStudy(target.uid);
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Remove confirmation
// ---------------------------------------------------------------------------
const ConfirmRemove: React.FC<{
  study: StudyMeta;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}> = ({ study, onCancel, onConfirm }) => {
  const [working, setWorking] = useState(false);
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: '#000a', zIndex: 110,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8,
          width: 460, padding: 22, color: '#ccc', fontSize: 13,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e5e5e5', marginBottom: 14 }}>
          Remove this study?
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>
          {study.name || study.uid}
        </div>
        <div style={{ fontSize: 11, color: '#777', marginBottom: 18, lineHeight: 1.6 }}>
          This deletes the study from the worklist and removes its derivatives
          (preprocess, vesselness, masks, centerlines) from the workspace folder.
          The original DICOM files are not touched.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={working}>Cancel</button>
          <button
            onClick={async () => { setWorking(true); try { await onConfirm(); } finally { setWorking(false); } }}
            disabled={working}
            style={{
              background: '#7f1d1d', border: '1px solid #991b1b', borderRadius: 4,
              color: '#fecaca', padding: '6px 16px', fontWeight: 600,
              cursor: working ? 'default' : 'pointer', opacity: working ? 0.6 : 1,
            }}
          >
            {working ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Workspace settings modal
// ---------------------------------------------------------------------------
const parentDir = (p: string): string => {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
};

const WorkspaceSettings: React.FC<{
  info: WorkspaceInfo | null;
  onClose: () => void;
  onSaved: (info: WorkspaceInfo) => void;
}> = ({ info, onClose, onSaved }) => {
  const [pathInput, setPathInput] = useState(info?.data_dir ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Folder browser state
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState(info?.data_dir ?? '/');
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [loadingFolders, setLoadingFolders] = useState(false);

  useEffect(() => {
    if (!browsing) return;
    setLoadingFolders(true);
    setBrowseError(null);
    listFolders(browsePath, false)
      .then(setFolders)
      .catch(err => {
        setFolders([]);
        setBrowseError(axiosErrorMessage(err));
      })
      .finally(() => setLoadingFolders(false));
  }, [browsing, browsePath]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await setWorkspace(pathInput.trim());
      onSaved({ data_dir: res.data_dir, default_data_dir: info?.default_data_dir ?? '', configured_via: 'config-file' });
      onClose();
    } catch (err) {
      setError(axiosErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: '#000a', zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8,
          width: 540, padding: 24, color: '#ccc', fontSize: 13,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e5e5e5', marginBottom: 16 }}>
          Workspace location
        </div>
        <div style={{ fontSize: 11, color: '#777', marginBottom: 14, lineHeight: 1.6 }}>
          Where preprocess, vesselness, masks, and centerline data are saved.
          Source DICOM files stay where they are; only derivatives go here.
        </div>

        <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>Current path</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            placeholder={info?.default_data_dir ?? '/path/to/workspace'}
            style={{
              flex: 1, padding: '8px 10px',
              background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 4,
              color: '#ddd', fontFamily: 'monospace', fontSize: 12,
            }}
          />
          <button
            onClick={() => { setBrowsePath(pathInput || info?.data_dir || '/'); setBrowsing(b => !b); }}
            style={{
              background: browsing ? '#2563eb' : '#222', border: '1px solid #333', borderRadius: 4,
              color: '#ddd', padding: '0 14px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {browsing ? 'Hide' : 'Browse…'}
          </button>
        </div>

        {browsing && (
          <div style={{ marginTop: 12, border: '1px solid #2a2a2a', borderRadius: 4, background: '#0d0d0d' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid #1e1e1e' }}>
              <button
                onClick={() => setBrowsePath(parentDir(browsePath))}
                disabled={browsePath === '/' || loadingFolders}
                title="Up one level"
                style={{
                  background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 3,
                  color: '#aaa', fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                }}
              >↑</button>
              <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {browsePath}
              </span>
              <button
                onClick={async () => {
                  const name = window.prompt(`New folder in:\n${browsePath}`);
                  if (!name) return;
                  try {
                    const { path } = await makeFolder(browsePath, name);
                    setBrowsePath(path);
                  } catch (err) {
                    setBrowseError(axiosErrorMessage(err));
                  }
                }}
                title="Create new folder here"
                style={{
                  background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 3,
                  color: '#aaa', fontSize: 11, padding: '2px 8px', cursor: 'pointer',
                }}
              >+ New folder</button>
              <button
                onClick={() => { setPathInput(browsePath); setBrowsing(false); }}
                style={{
                  background: '#14532d', border: '1px solid #166534', borderRadius: 3,
                  color: '#4ade80', fontSize: 11, padding: '2px 10px', cursor: 'pointer', fontWeight: 600,
                }}
              >
                Use this folder
              </button>
            </div>
            {browseError && <div style={{ color: '#ef4444', fontSize: 11, padding: '8px 10px' }}>{browseError}</div>}
            <ul style={{
              listStyle: 'none', margin: 0, padding: 0,
              maxHeight: 220, overflow: 'auto',
            }}>
              {loadingFolders && <li style={{ padding: '6px 10px', color: '#555', fontSize: 11 }}>Loading…</li>}
              {!loadingFolders && folders.length === 0 && !browseError && (
                <li style={{ padding: '6px 10px', color: '#555', fontSize: 11 }}>No subfolders.</li>
              )}
              {folders.map(f => (
                <li
                  key={f.path}
                  onClick={() => setBrowsePath(f.path)}
                  style={{
                    padding: '5px 10px', cursor: 'pointer', fontSize: 12, color: '#ccc',
                    fontFamily: 'monospace', borderBottom: '1px solid #161616',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1a1a1a')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  📁 {f.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        {info && (
          <div style={{ fontSize: 10, color: '#555', marginTop: 6 }}>
            Default: <code>{info.default_data_dir}</code>
            {' · '}Set via: <code>{info.configured_via}</code>
            {info.configured_via === 'env' && (
              <span style={{ color: '#f5a623', marginLeft: 8 }}>
                ⚠ ACCTA_DATA_DIR env var is set and overrides this setting until unset.
              </span>
            )}
          </div>
        )}

        {error && <div style={{ color: '#ef4444', fontSize: 11, marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || !pathInput.trim() || pathInput.trim() === info?.data_dir}
            style={{
              background: '#2563eb', border: 'none', borderRadius: 4,
              color: '#fff', padding: '6px 16px', fontWeight: 600,
              cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Worklist;
