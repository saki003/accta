import React, { useState } from 'react';
import Worklist from './components/Worklist';
import Session from './components/Session';
import type { StudyMeta } from './api/types';

const App: React.FC = () => {
  const [sessionStudy, setSessionStudy] = useState<StudyMeta | null>(null);

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#111', color: '#eee',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {sessionStudy ? (
        <Session study={sessionStudy} onBack={() => setSessionStudy(null)} />
      ) : (
        <Worklist onOpen={setSessionStudy} />
      )}
    </div>
  );
};

export default App;
