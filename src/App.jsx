import { useState, useEffect, useCallback } from 'react';
import './App.css';

export default function App() {
  const [count, setCount] = useState(0);
  const [step, setStep] = useState(1);
  const [totalClicks, setTotalClicks] = useState(0);
  const [maxVal, setMaxVal] = useState(0);
  const [minVal, setMinVal] = useState(0);
  const [isPulsing, setIsPulsing] = useState(false);
  const [history, setHistory] = useState([]);

  // Trigger pulse animation briefly on count changes
  const triggerPulse = useCallback(() => {
    setIsPulsing(true);
    const timer = setTimeout(() => setIsPulsing(false), 200);
    return () => clearTimeout(timer);
  }, []);

  // Update records (max, min, history)
  const recordUpdate = useCallback((newVal, actionText, typeClass) => {
    setCount(newVal);
    setTotalClicks((prev) => prev + 1);
    setMaxVal((prev) => Math.max(prev, newVal));
    setMinVal((prev) => Math.min(prev, newVal));

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setHistory((prev) => [
      { id: Date.now() + Math.random(), action: actionText, val: newVal, time: timestamp, type: typeClass },
      ...prev.slice(0, 9),
    ]);
    triggerPulse();
  }, [triggerPulse]);

  // Core counter actions
  const handleIncrement = useCallback(() => {
    recordUpdate(count + step, `+${step}`, 'pos');
  }, [count, step, recordUpdate]);

  const handleDecrement = useCallback(() => {
    recordUpdate(count - step, `-${step}`, 'neg');
  }, [count, step, recordUpdate]);

  const handleReset = useCallback(() => {
    if (count === 0) return;
    recordUpdate(0, 'Reset', 'reset');
  }, [count, recordUpdate]);

  const handleDouble = useCallback(() => {
    if (count === 0) return;
    recordUpdate(count * 2, '×2', count > 0 ? 'pos' : 'neg');
  }, [count, recordUpdate]);

  const handleInvert = useCallback(() => {
    if (count === 0) return;
    recordUpdate(-count, '±', count > 0 ? 'neg' : 'pos');
  }, [count, recordUpdate]);

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  // Keyboard accessibility
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowUp' || e.key === '+') {
        e.preventDefault();
        handleIncrement();
      } else if (e.key === 'ArrowDown' || e.key === '-') {
        e.preventDefault();
        handleDecrement();
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleReset();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleIncrement, handleDecrement, handleReset]);

  // Status badge styling & text
  const stateClass = count > 0 ? 'positive' : count < 0 ? 'negative' : 'zero';
  const badgeText = count > 0 ? 'Positive' : count < 0 ? 'Negative' : 'Zero';
  const badgeClass = count > 0 ? 'badge-positive' : count < 0 ? 'badge-negative' : 'badge-zero';

  return (
    <div className="app-card" id="bluegreen-counter-app">
      {/* Header */}
      <header className="app-header" id="app-header">
        <div className="brand-wrapper">
          <div className="brand-icon" aria-hidden="true">BG</div>
          <div>
            <h1 className="brand-title" id="app-title">BlueGreen</h1>
            <p className="brand-subtitle">Simple Counter</p>
          </div>
        </div>
        <div className="version-pill" id="app-version-badge">
          <span className="version-dot"></span>
          <span>v1.0</span>
        </div>
      </header>

      {/* Main Counter Display */}
      <main>
        <section className="counter-display-wrapper" aria-live="polite">
          <div className="counter-glow-ring" aria-hidden="true"></div>
          <div
            id="counter-value"
            className={`counter-value ${stateClass} ${isPulsing ? 'pulse' : ''}`}
            aria-label={`Current count is ${count}`}
          >
            {count}
          </div>
          <span id="counter-badge" className={`state-badge ${badgeClass}`}>
            {badgeText}
          </span>
        </section>

        {/* Step Selector */}
        <section className="step-selector-row" style={{ marginTop: '20px' }}>
          <span className="step-label">Step Increment:</span>
          <div className="step-chips" role="radiogroup" aria-label="Step increment">
            {[1, 5, 10].map((s) => (
              <button
                key={s}
                id={`step-${s}`}
                type="button"
                className={`step-chip ${step === s ? 'active' : ''}`}
                onClick={() => setStep(s)}
                aria-pressed={step === s}
              >
                ±{s}
              </button>
            ))}
          </div>
        </section>

        {/* Primary Controls */}
        <section className="primary-controls" style={{ marginTop: '16px' }}>
          <button
            id="btn-decrement"
            type="button"
            className="btn-counter btn-decrement"
            onClick={handleDecrement}
            title={`Decrease by ${step} (Arrow Down)`}
            aria-label={`Decrease by ${step}`}
          >
            <span className="btn-symbol">−</span>
            <span>Decrease</span>
          </button>

          <button
            id="btn-increment"
            type="button"
            className="btn-counter btn-increment"
            onClick={handleIncrement}
            title={`Increase by ${step} (Arrow Up)`}
            aria-label={`Increase by ${step}`}
          >
            <span className="btn-symbol">+</span>
            <span>Increase</span>
          </button>
        </section>

        {/* Secondary Controls */}
        <section className="secondary-controls" style={{ marginTop: '14px' }}>
          <button
            id="btn-reset"
            type="button"
            className="btn-secondary btn-reset"
            onClick={handleReset}
            disabled={count === 0}
            title="Reset to 0 (Press R)"
            aria-label="Reset counter to zero"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Reset
          </button>

          <button
            id="btn-double"
            type="button"
            className="btn-secondary"
            onClick={handleDouble}
            disabled={count === 0}
            title="Multiply current value by 2"
            aria-label="Multiply by 2"
          >
            ×2
          </button>

          <button
            id="btn-invert"
            type="button"
            className="btn-secondary"
            onClick={handleInvert}
            disabled={count === 0}
            title="Invert current positive or negative sign"
            aria-label="Invert sign"
          >
            ± Sign
          </button>
        </section>

        {/* Stats Grid */}
        <section className="stats-grid" style={{ marginTop: '20px' }}>
          <div className="stat-item" id="stat-clicks">
            <div className="stat-label">Total Clicks</div>
            <div className="stat-value">{totalClicks}</div>
          </div>
          <div className="stat-item" id="stat-max">
            <div className="stat-label">Max Reached</div>
            <div className="stat-value">{maxVal}</div>
          </div>
          <div className="stat-item" id="stat-min">
            <div className="stat-label">Min Reached</div>
            <div className="stat-value">{minVal}</div>
          </div>
        </section>

        {/* History Timeline */}
        <section className="history-section" style={{ marginTop: '20px' }}>
          <div className="history-header">
            <span className="history-title">Recent Activity</span>
            {history.length > 0 && (
              <button
                id="btn-clear-history"
                type="button"
                className="btn-clear-history"
                onClick={clearHistory}
                aria-label="Clear recent activity log"
              >
                Clear
              </button>
            )}
          </div>
          <div className="history-list" id="history-list">
            {history.length === 0 ? (
              <div className="empty-history">No activity yet. Click + or − to start!</div>
            ) : (
              history.map((item) => (
                <div key={item.id} className="history-item">
                  <span className={`history-action ${item.type}`}>{item.action}</span>
                  <span className="history-result">Value: {item.val}</span>
                  <span className="history-time">{item.time}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="app-footer" id="app-footer">
        <span className="kbd-hint">
          <kbd>↑</kbd> Increment
        </span>
        <span className="kbd-hint">
          <kbd>↓</kbd> Decrement
        </span>
        <span className="kbd-hint">
          <kbd>R</kbd> Reset
        </span>
      </footer>
    </div>
  );
}
