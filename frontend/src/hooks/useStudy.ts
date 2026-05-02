/**
 * useStudy — React hook for managing loaded CT studies.
 *
 * Provides:
 *  - studies        list of all loaded StudyMeta objects
 *  - currentStudy   the currently selected StudyMeta (or null)
 *  - loading        true while an async operation is in flight
 *  - error          last error message, or null
 *  - loadStudies()  refresh the studies list from the backend
 *  - uploadStudy()  upload a File and add it to the list
 *  - selectStudy()  switch currentStudy by uid
 *  - removeStudy()  delete from backend and local list
 */

import { useCallback, useState } from 'react';
import * as client from '../api/client';
import type { StudyMeta } from '../api/types';

interface UseStudyReturn {
  studies: StudyMeta[];
  currentStudy: StudyMeta | null;
  loading: boolean;
  error: string | null;
  loadStudies: () => Promise<void>;
  uploadStudy: (file: File) => Promise<StudyMeta | null>;
  addStudy: (meta: StudyMeta) => void;
  selectStudy: (uid: string) => void;
  removeStudy: (uid: string) => Promise<void>;
}

export function useStudy(): UseStudyReturn {
  const [studies, setStudies] = useState<StudyMeta[]>([]);
  const [currentStudy, setCurrentStudy] = useState<StudyMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStudies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await client.getStudies();
      setStudies(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const uploadStudy = useCallback(async (file: File): Promise<StudyMeta | null> => {
    setLoading(true);
    setError(null);
    try {
      const meta = await client.uploadStudy(file);
      setStudies((prev) => {
        // Replace if already present, otherwise append
        const idx = prev.findIndex((s) => s.uid === meta.uid);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = meta;
          return next;
        }
        return [...prev, meta];
      });
      setCurrentStudy(meta);
      return meta;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const addStudy = useCallback((meta: StudyMeta) => {
    setStudies((prev) => {
      // Deduplicate by uid OR by patient+series name (keep the new one)
      const [patientKey, seriesDesc] = meta.name.split(' — ');
      const idx = prev.findIndex((s) => {
        if (s.uid === meta.uid) return true;
        const [pk, sd] = s.name.split(' — ');
        return pk === patientKey && sd === seriesDesc;
      });
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = meta;
        return next;
      }
      return [...prev, meta];
    });
    setCurrentStudy(meta);
  }, []);

  const selectStudy = useCallback(
    (uid: string) => {
      const found = studies.find((s) => s.uid === uid) ?? null;
      setCurrentStudy(found);
    },
    [studies],
  );

  const removeStudy = useCallback(async (uid: string) => {
    // Optimistic update: drop from the worklist immediately so the user sees
    // it disappear, then run the (potentially slow, e.g. shutil.rmtree of a
    // large workspace) backend delete.  On failure, restore the row.
    let removedSnapshot: StudyMeta | undefined;
    setStudies((prev) => {
      removedSnapshot = prev.find((s) => s.uid === uid);
      return prev.filter((s) => s.uid !== uid);
    });
    setCurrentStudy((prev) => (prev?.uid === uid ? null : prev));
    setError(null);
    try {
      await client.removeStudy(uid);
    } catch (err) {
      // Restore the row if the server rejected the delete.
      if (removedSnapshot) setStudies((prev) => [...prev, removedSnapshot!]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return {
    studies,
    currentStudy,
    loading,
    error,
    loadStudies,
    uploadStudy,
    addStudy,
    selectStudy,
    removeStudy,
  };
}
