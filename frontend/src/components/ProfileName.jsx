import { useContext, useState } from 'react';
import { Pencil } from 'lucide-react';
import axios from 'axios';
import AuthContext from '../context/AuthContext';
import './Username.css';

// The name at the top of your own profile, with editing.
function ProfileName({ username, onSaved }) {
  const { updateUserData } = useContext(AuthContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(username);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    setDraft(username);
    setError('');
    setEditing(true);
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await axios.put('/api/auth/me/username', { username: draft.trim() });
      onSaved(res.data.username);
      setEditing(false);
      // Updates the navigation bar and the rest of the app
      await updateUserData();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not change your username');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="username-heading">
        <h1 className="htb-user-name">{username}</h1>
        <button type="button" className="username-button" onClick={startEditing}>
          <Pencil size={14} /> Edit username
        </button>
      </div>
    );
  }

  return (
    <form className="username-edit" onSubmit={save}>
      <input
        className="username-field"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Username"
        autoComplete="off"
        minLength={3}
        maxLength={30}
        pattern="[A-Za-z0-9_\-]+"
        title="Letters, numbers, underscores and hyphens, with no spaces"
        required
        autoFocus
      />
      <div className="username-actions">
        <button type="submit" className="username-button username-button--primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button type="button" className="username-button" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
      </div>
      {error && <div className="username-error" role="alert">{error}</div>}
    </form>
  );
}

export default ProfileName;
