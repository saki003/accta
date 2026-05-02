/**
 * Re-exports the UseStudyReturn type so components can reference it without
 * importing from the hook module directly (avoids circular-import warnings).
 */
import type { useStudy } from './useStudy';

export type UseStudyReturn = ReturnType<typeof useStudy>;
