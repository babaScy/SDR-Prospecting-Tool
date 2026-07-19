import { useState } from 'react';
import PullScreen from './components/PullScreen';
import ListsScreen from './components/ListsScreen';
import ReviewScreen from './components/ReviewScreen';

export default function App() {
  const [view, setView] = useState({ name: 'pull' });

  return (
    <div className="app">
      <header className="topbar">
        <h1>Prospector</h1>
        <nav>
          <button className={view.name === 'pull' ? 'active' : ''} onClick={() => setView({ name: 'pull' })}>
            Pull
          </button>
          <button
            className={view.name === 'lists' || view.name === 'review' ? 'active' : ''}
            onClick={() => setView({ name: 'lists' })}
          >
            Lists
          </button>
        </nav>
      </header>
      <main>
        {view.name === 'pull' && <PullScreen />}
        {view.name === 'lists' && <ListsScreen onOpen={(listId) => setView({ name: 'review', listId })} />}
        {view.name === 'review' && <ReviewScreen listId={view.listId} onBack={() => setView({ name: 'lists' })} />}
      </main>
    </div>
  );
}
