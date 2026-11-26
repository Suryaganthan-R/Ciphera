import { useEffect, useState, useContext } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Users, Plus, LogIn, AlertCircle } from 'lucide-react';
import axios from 'axios';
import AuthContext from '../context/AuthContext';
import { Loading } from '../components/ui';
import './MyTeam.css';

function MyTeam() {
  const [pageLoading, setPageLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [teams, setTeams] = useState([]);
  const [createForm, setCreateForm] = useState({ name: '', password: '' });
  const [joinForm, setJoinForm] = useState({ teamId: '', password: '', inviteCode: '' });
  const { isAuthenticated, loading } = useContext(AuthContext);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteCode = searchParams.get('invite') || '';

  useEffect(() => {
    let active = true;
    const loadTeamOptions = async () => {
      if (loading) return;
      if (!isAuthenticated) {
        const from = inviteCode ? `/my-team?invite=${encodeURIComponent(inviteCode)}` : '/my-team';
        navigate('/login', { state: { from } });
        return;
      }
      try {
        const [myTeamResponse, teamsResponse] = await Promise.all([
          axios.get('/api/teams/my/team', {
            params: { _fresh: Date.now() },
            headers: { 'Cache-Control': 'no-cache' }
          }).catch(err => err.response?.status === 404 ? null : Promise.reject(err)),
          axios.get('/api/teams/available', {
            params: { _fresh: Date.now() },
            headers: { 'Cache-Control': 'no-cache' }
          })
        ]);
        if (!active) return;
        setTeams(teamsResponse.data.data || []);
        if (myTeamResponse?.data?.data) {
          navigate(`/team/${myTeamResponse.data.data._id}`, { replace: true });
          return;
        }
        if (inviteCode) {
          setJoinForm(current => ({ ...current, inviteCode }));
          setSubmitting(true);
          try {
            const joined = await axios.post('/api/teams/join', { inviteCode });
            navigate(`/team/${joined.data.data._id}`, { replace: true });
            return;
          } catch (joinError) {
            setError(joinError.response?.data?.message || 'This invitation link could not be used.');
          } finally {
            setSubmitting(false);
          }
        }
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load teams.');
      } finally {
        if (active) setPageLoading(false);
      }
    };
    loadTeamOptions();
    return () => { active = false; };
  }, [isAuthenticated, loading, navigate, inviteCode]);

  const handleCreate = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const response = await axios.post('/api/teams/self', createForm);
      navigate(`/team/${response.data.data._id}`);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create team.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const payload = joinForm.inviteCode.trim()
        ? { inviteCode: joinForm.inviteCode.trim() }
        : { teamId: joinForm.teamId, password: joinForm.password };
      const response = await axios.post('/api/teams/join', payload);
      setSuccess('Joined team successfully.');
      navigate(`/team/${response.data.data._id}`);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to join team.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || pageLoading) {
    return (
      <div className="my-team-container">
        <Loading text="LOADING TEAM..." />
      </div>
    );
  }

  return (
    <div className="my-team-container">
      <div className="my-team-panel">
        <header className="my-team-heading">
          <Users size={28} />
          <div>
            <h1>My Team</h1>
            <p>Create a team or join one with its password or invite link.</p>
          </div>
        </header>

        {error && <div className="my-team-feedback my-team-error"><AlertCircle size={18} />{error}</div>}
        {success && <div className="my-team-feedback my-team-success">{success}</div>}

        <div className="my-team-actions-grid">
          <form className="my-team-form" onSubmit={handleCreate}>
            <h2><Plus size={19} /> Create a team</h2>
            <label htmlFor="team-name">Team name</label>
            <input
              id="team-name"
              value={createForm.name}
              onChange={event => setCreateForm(current => ({ ...current, name: event.target.value }))}
              maxLength={100}
              required
            />
            <label htmlFor="team-password">Team password</label>
            <input
              id="team-password"
              type="password"
              value={createForm.password}
              onChange={event => setCreateForm(current => ({ ...current, password: event.target.value }))}
              minLength={8}
              autoComplete="new-password"
              required
            />
            <small>Four members maximum. You’ll be the captain.</small>
            <button type="submit" disabled={submitting}>{submitting ? 'Working...' : 'Create team'}</button>
          </form>

          <form className="my-team-form" onSubmit={handleJoin}>
            <h2><LogIn size={19} /> Join a team</h2>
            <label htmlFor="join-team">Available teams</label>
            <select
              id="join-team"
              value={joinForm.teamId}
              onChange={event => setJoinForm(current => ({ ...current, teamId: event.target.value }))}
              disabled={Boolean(joinForm.inviteCode)}
              required={!joinForm.inviteCode}
            >
              <option value="">Select a team</option>
              {teams.map(team => (
                <option key={team._id} value={team._id} disabled={team.memberCount >= team.maxMembers}>
                  {team.name} ({team.memberCount}/{team.maxMembers})
                </option>
              ))}
            </select>
            <label htmlFor="join-team-password">Team password</label>
            <input
              id="join-team-password"
              type="password"
              value={joinForm.password}
              onChange={event => setJoinForm(current => ({ ...current, password: event.target.value }))}
              autoComplete="current-password"
              disabled={Boolean(joinForm.inviteCode)}
              required={!joinForm.inviteCode}
            />
            <div className="my-team-or">or use an invitation link</div>
            <label htmlFor="team-invite-code">Invite code</label>
            <input
              id="team-invite-code"
              value={joinForm.inviteCode}
              onChange={event => setJoinForm(current => ({ ...current, inviteCode: event.target.value, teamId: '' }))}
              placeholder="Paste an invite code or open the invite link"
            />
            <button type="submit" disabled={submitting}>{submitting ? 'Working...' : 'Join team'}</button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default MyTeam;
