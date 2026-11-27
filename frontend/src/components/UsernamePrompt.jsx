import { useState } from 'react';
import { createPortal } from 'react-dom';
import './Username.css';

// Asked once, the first time someone signs in with Google.
function UsernamePrompt({ suggestion, onSubmit, onCancel }) {
  const [username, setUsername] = useState(suggestion || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSubmit(username.trim());
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return createPortal(
    <div className="username-prompt-overlay">
      <form
        className="username-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="username-prompt-title"
        onSubmit={handleSubmit}
      >
        <h2 id="username-prompt-title">Choose your username</h2>
        <p>This is the name shown to everyone. You can change it later in your profile.</p>
        <input
          className="username-field"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-label="Username"
          autoComplete="off"
          minLength={3}
          maxLength={30}
          pattern="[A-Za-z0-9_\-]+"
          title="Letters, numbers, underscores and hyphens, with no spaces"
          required
          autoFocus
        />
        <small>3 to 30 letters, numbers, underscores or hyphens.</small>
        {error && <div className="username-error" role="alert">{error}</div>}
        <div className="username-actions">
          <button type="button" className="username-button" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="submit" className="username-button username-button--primary" disabled={saving}>
            {saving ? 'Saving...' : 'Continue'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

export default UsernamePrompt;
