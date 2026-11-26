import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Crown, Minus, Plus, X } from 'lucide-react';
import axios from 'axios';
import './TeamScoreModal.css';

// Admin view of one team: members, and score changes made by solving or unsolving challenges
function TeamScoreModal({ teamId, onClose, onScoreChange }) {
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [addId, setAddId] = useState('');
  const [creditId, setCreditId] = useState('');
  const [removeId, setRemoveId] = useState('');

  useEffect(() => {
    let active = true;
    axios.get(`/api/admin/teams/${teamId}/score`, { params: { _fresh: Date.now() } })
      .then(res => {
        if (!active) return;
        setDetails(res.data.data);
        onScoreChange(teamId, res.data.data.score);
      })
      .catch(err => {
        if (active) setError(err.response?.data?.message || 'Failed to load the team.');
      });
    return () => { active = false; };
    // onScoreChange only mirrors the score into the table, so it must not trigger a reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  useEffect(() => {
    const closeOnEscape = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const toAdd = details?.unsolved.find(item => item.challengeId === addId);
  const toRemove = details?.solved.find(item => item.challengeId === removeId);
  const players = details?.members.filter(member => member.canBeCredited) || [];

  const save = async (request, message) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await request();
      const data = res.data.data;
      setDetails(data);
      onScoreChange(teamId, data.score);
      setSuccess(`${message} Team score is now ${data.score} points.`);
      setAddId('');
      setRemoveId('');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update the team score.');
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = event => {
    event.preventDefault();
    if (!toAdd) return;
    if (!window.confirm(`Mark "${toAdd.title}" as solved for ${details.team.name}? This adds its points.`)) return;
    save(
      () => axios.post(`/api/admin/teams/${teamId}/solves`, {
        challengeId: toAdd.challengeId,
        userId: creditId || undefined
      }),
      `Marked "${toAdd.title}" as solved.`
    );
  };

  const handleRemove = event => {
    event.preventDefault();
    if (!toRemove) return;
    if (!window.confirm(`Mark "${toRemove.title}" as unsolved for ${details.team.name}? This deletes the solve and removes ${toRemove.points} points.`)) return;
    save(
      () => axios.delete(`/api/admin/teams/${teamId}/solves/${toRemove.challengeId}`),
      `Marked "${toRemove.title}" as unsolved.`
    );
  };

  return createPortal(
    <div className="team-score-overlay" onClick={onClose}>
      <div
        className="team-score-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Team members and score"
        onClick={event => event.stopPropagation()}
      >
        <header className="team-score-header">
          <div>
            <h2>{details?.team.name || 'Team'}</h2>
            {details && (
              <p>
                <strong>{details.score}</strong> points · {details.solved.length} solved · {details.hintsUnlocked} hints unlocked
                {' · '}<Link to={`/teams/${teamId}`}>Open team page</Link>
              </p>
            )}
          </div>
          <button type="button" className="team-score-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>

        {error && <p className="team-score-message team-score-error">{error}</p>}
        {success && <p className="team-score-message">{success}</p>}
        {!details && !error && <p className="team-score-message">Loading team...</p>}

        {details && (
          <>
            {details.pointsOwed > 0 && (
              <p className="team-score-message team-score-error">
                Hint costs exceed this team&apos;s points by {details.pointsOwed}. The score shows 0, and new points first cover this amount.
              </p>
            )}

            <h3>Members</h3>
            <div className="team-score-table">
              <table>
                <thead>
                  <tr><th>Member</th><th>Points from solves</th><th>Solved</th><th>Hints</th></tr>
                </thead>
                <tbody>
                  {details.members.map(member => (
                    <tr key={member._id}>
                      <td>{member.username} {member.isCaptain && <Crown size={14} aria-label="Captain" />}</td>
                      <td>{member.points}</td>
                      <td>{member.solved}</td>
                      <td>{member.hints}</td>
                    </tr>
                  ))}
                  {!details.members.length && <tr><td colSpan={4}>This team has no members.</td></tr>}
                </tbody>
              </table>
            </div>

            <form className="team-score-form" onSubmit={handleAdd}>
              <h3><Plus size={16} /> Increase score</h3>
              <label htmlFor="team-score-add">Challenge to mark as solved</label>
              <select id="team-score-add" value={addId} onChange={event => setAddId(event.target.value)} required>
                <option value="">Select a challenge</option>
                {details.unsolved.map(item => (
                  <option key={item.challengeId} value={item.challengeId}>
                    {item.title} ({item.category}) +{item.points}
                  </option>
                ))}
              </select>
              <label htmlFor="team-score-credit">Credit the solve to</label>
              <select id="team-score-credit" value={creditId} onChange={event => setCreditId(event.target.value)}>
                <option value="">Captain (default)</option>
                {players.map(member => <option key={member._id} value={member._id}>{member.username}</option>)}
              </select>
              <button type="submit" disabled={saving || !toAdd || !players.length}>
                {toAdd ? `Mark solved (+${toAdd.points})` : 'Mark solved'}
              </button>
              {!details.unsolved.length && <small>There are no unsolved challenges.</small>}
              {!players.length && <small>Add a player to this team first.</small>}
            </form>

            <form className="team-score-form" onSubmit={handleRemove}>
              <h3><Minus size={16} /> Reduce score</h3>
              <label htmlFor="team-score-remove">Solved challenge to mark as unsolved</label>
              <select id="team-score-remove" value={removeId} onChange={event => setRemoveId(event.target.value)} required>
                <option value="">Select a solved challenge</option>
                {details.solved.map(item => (
                  <option key={item.challengeId} value={item.challengeId}>
                    {item.title} −{item.points}
                    {item.solvedBy.length ? ` (${item.solvedBy.join(', ')}${item.addedByAdmin ? ', added by admin' : ''})` : ' (solver left the team)'}
                  </option>
                ))}
              </select>
              <button type="submit" className="team-score-danger" disabled={saving || !toRemove}>
                {toRemove ? `Mark unsolved (−${toRemove.points})` : 'Mark unsolved'}
              </button>
              {!details.solved.length && <small>This team has not solved any challenge.</small>}
            </form>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

export default TeamScoreModal;
