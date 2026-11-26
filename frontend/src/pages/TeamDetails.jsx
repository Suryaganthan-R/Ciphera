import { useState, useEffect, useContext } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ChevronLeft, Users, Award, Trophy, Zap, Crown, Lock, Shield, Link2, KeyRound, Trash2, LogOut } from 'lucide-react';
import axios from 'axios';
import AuthContext from '../context/AuthContext';
import { Loading } from '../components/ui';
import './TeamDetails.css';

function TeamDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, loading: authLoading, user } = useContext(AuthContext);

  const [team, setTeam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [teamPassword, setTeamPassword] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const fetchTeamDetails = async () => {
    const res = await axios.get(`/api/teams/${id}`, {
      params: { _fresh: Date.now() },
      headers: { 'Cache-Control': 'no-cache' }
    });
    setTeam(res.data.data);
  };

  useEffect(() => {
    const loadTeamPage = async () => {
      // Wait for auth to finish loading
      if (authLoading) {
        return;
      }

      if (!isAuthenticated) {
        navigate('/login');
        return;
      }

      try {
        // Cookie sent automatically
        await fetchTeamDetails();
      } catch (err) {
        console.error('Error fetching team details:', err);
        setError(err.response?.data?.message || 'Failed to load team details');
      } finally {
        setLoading(false);
      }
    };

    loadTeamPage();
  }, [id, isAuthenticated, authLoading, navigate]);

  const handleCreateInvite = async () => {
    setActionLoading(true);
    setActionError('');
    try {
      const response = await axios.post('/api/teams/my/team/invite');
      setInviteUrl(`${window.location.origin}/my-team?invite=${encodeURIComponent(response.data.inviteCode)}`);
      setActionMessage('Invite link ready to share.');
    } catch (actionErrorResponse) {
      setActionError(actionErrorResponse.response?.data?.message || 'Failed to create an invite link.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setActionMessage('Invite link copied.');
    } catch {
      setActionError('Could not copy automatically. Select and copy the invite link.');
    }
  };

  const handlePasswordChange = async (event) => {
    event.preventDefault();
    setActionLoading(true);
    setActionError('');
    setActionMessage('');
    try {
      await axios.put('/api/teams/my/team/password', { password: teamPassword });
      setTeamPassword('');
      setActionMessage('Team password updated.');
    } catch (actionErrorResponse) {
      setActionError(actionErrorResponse.response?.data?.message || 'Failed to update team password.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleLeaveTeam = async () => {
    if (!window.confirm('Leave this team? Your past solves will no longer count toward its team score.')) return;
    setActionLoading(true);
    setActionError('');
    try {
      await axios.delete('/api/teams/my/team/membership');
      navigate('/my-team', { replace: true });
    } catch (actionErrorResponse) {
      setActionError(actionErrorResponse.response?.data?.message || 'Failed to leave team.');
      setActionLoading(false);
    }
  };

  const handleDisbandTeam = async () => {
    if (!window.confirm(`Disband ${team.name}? This removes the team and clears all member assignments.`)) return;
    setActionLoading(true);
    setActionError('');
    try {
      await axios.delete('/api/teams/my/team');
      navigate('/my-team', { replace: true });
    } catch (actionErrorResponse) {
      setActionError(actionErrorResponse.response?.data?.message || 'Failed to disband team.');
      setActionLoading(false);
    }
  };

  // Show loading only after auth is done
  if (authLoading || loading) {
    return (
      <div className="htb-team-container">
        <div className="htb-team-grid-bg"></div>
        <Loading text="LOADING TEAM..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="htb-team-container">
        <div className="htb-team-grid-bg"></div>
        <motion.div 
          className="htb-error-state"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <p>{error}</p>
          <motion.button 
            className="htb-back-btn"
            onClick={() => navigate('/scoreboard')}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <ChevronLeft size={20} />
            Back to Scoreboard
          </motion.button>
        </motion.div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="htb-team-container">
        <div className="htb-team-grid-bg"></div>
        <motion.div 
          className="htb-error-state"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <p>Team not found</p>
          <motion.button 
            className="htb-back-btn"
            onClick={() => navigate('/scoreboard')}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <ChevronLeft size={20} />
            Back to Scoreboard
          </motion.button>
        </motion.div>
      </div>
    );
  }

  // Sort members by points (highest first)
  const sortedMembers = [...team.members].sort((a, b) => (b.points || 0) - (a.points || 0));

  // Captain is either from the database (already populated) or defaults to highest scorer
  let captain = null;
  if (team.captain) {
    // If captain is populated as an object with _id
    if (typeof team.captain === 'object' && team.captain._id) {
      captain = team.captain;
    } else {
      // If captain is just an ID string, find it in members
      captain = team.members.find(m => m._id === team.captain || m._id.toString() === team.captain.toString());
    }
  }
  // If no captain set, default to highest scorer
  if (!captain) {
    captain = sortedMembers[0];
  }

  return (
    <div className="htb-team-container">
      <div className="htb-team-grid-bg"></div>
      
      <motion.div 
        className="htb-team-header"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <motion.button 
          className="htb-back-btn"
          onClick={() => navigate('/scoreboard')}
          whileHover={{ scale: 1.05, x: -5 }}
          whileTap={{ scale: 0.95 }}
        >
          <ChevronLeft size={20} />
          Back
        </motion.button>
        <h1 className="htb-team-name">{team.name}</h1>
      </motion.div>

      <div className="htb-team-main">
        <motion.section className="htb-team-controls" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {actionError && <p className="htb-team-action-message htb-team-action-error">{actionError}</p>}
          {actionMessage && <p className="htb-team-action-message">{actionMessage}</p>}
          {team.isCaptain ? (
            <>
              <div className="htb-team-action-row">
                <button type="button" className="htb-team-action-btn" onClick={handleCreateInvite} disabled={actionLoading}>
                  <Link2 size={17} /> {actionLoading ? 'Working...' : 'Create invite link'}
                </button>
                <button type="button" className="htb-team-action-btn htb-team-action-danger" onClick={handleDisbandTeam} disabled={actionLoading}>
                  <Trash2 size={17} /> Disband team
                </button>
              </div>
              {inviteUrl && (
                <div className="htb-team-invite-row">
                  <input aria-label="Team invite link" value={inviteUrl} readOnly onFocus={event => event.target.select()} />
                  <button type="button" className="htb-team-action-btn" onClick={handleCopyInvite}>Copy link</button>
                </div>
              )}
              <form className="htb-team-password-form" onSubmit={handlePasswordChange}>
                <label htmlFor="new-team-password"><KeyRound size={16} /> Change team password</label>
                <input
                  id="new-team-password"
                  type="password"
                  value={teamPassword}
                  onChange={event => setTeamPassword(event.target.value)}
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  required
                />
                <button type="submit" className="htb-team-action-btn" disabled={actionLoading || !teamPassword}>
                  Update password
                </button>
              </form>
            </>
          ) : team.members.some(member => String(member._id) === String(user?._id || user?.id)) ? (
            <button type="button" className="htb-team-action-btn htb-team-action-danger" onClick={handleLeaveTeam} disabled={actionLoading}>
              <LogOut size={17} /> Leave team
            </button>
          ) : null}
        </motion.section>

        <motion.div 
          className="htb-team-stats"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <motion.div 
            className="htb-stat-card htb-stat-points"
            whileHover={{ scale: 1.02, y: -4 }}
          >
            <div className="htb-stat-icon">
              <Trophy size={24} />
            </div>
            <div className="htb-stat-content">
              <div className="htb-stat-label">Total Points</div>
              <div className="htb-stat-value">{team.points || 0}</div>
            </div>
          </motion.div>

          <motion.div 
            className="htb-stat-card htb-stat-members"
            whileHover={{ scale: 1.02, y: -4 }}
          >
            <div className="htb-stat-icon">
              <Users size={24} />
            </div>
            <div className="htb-stat-content">
              <div className="htb-stat-label">Team Members</div>
              <div className="htb-stat-value">{team.members.length}</div>
            </div>
          </motion.div>

          <motion.div 
            className="htb-stat-card htb-stat-challenges"
            whileHover={{ scale: 1.02, y: -4 }}
          >
            <div className="htb-stat-icon">
              <Award size={24} />
            </div>
            <div className="htb-stat-content">
              <div className="htb-stat-label">Challenges Solved</div>
              <div className="htb-stat-value">
                {team.members.reduce((sum, member) => sum + (member.personallySolvedChallenges?.length || 0), 0)}
              </div>
            </div>
          </motion.div>
        </motion.div>

        <motion.div 
          className="htb-team-section"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <h2 className="htb-section-title">
            <span className="htb-title-line"></span>
            Team Members
          </h2>

          {captain && (
            <motion.div 
              className="htb-member-card htb-captain"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
            >
              <div className="htb-captain-badge">
                <Crown size={16} />
                <span>Captain</span>
              </div>
              <div 
                className="htb-member-info"
                onClick={() => navigate(`/user/${captain._id}`)}
              >
                <div className="htb-member-name">{captain.username}</div>
                <div className="htb-member-email">{captain.email}</div>
              </div>
              <div className="htb-member-stats">
                <div className="htb-member-stat">
                  <Zap size={16} />
                  <span>{captain.points || 0} pts</span>
                </div>
                <div className="htb-member-stat">
                  <Award size={16} />
                  <span>{captain.personallySolvedChallenges?.length || 0} solved</span>
                </div>
                <div className="htb-member-stat">
                  <Lock size={16} />
                  <span>{captain.unlockedHints?.length || 0} hints</span>
                </div>
              </div>
            </motion.div>
          )}

          <div className="htb-members-grid">
            {sortedMembers.filter(m => m._id !== captain?._id).map((member, index) => (
              <motion.div 
                key={member._id}
                className="htb-member-card"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 + index * 0.05 }}
              >
                <div className="htb-member-rank">
                  <Shield size={18} />
                </div>
                <div 
                  className="htb-member-info"
                  onClick={() => navigate(`/user/${member._id}`)}
                >
                  <div className="htb-member-name">{member.username}</div>
                  <div className="htb-member-email">{member.email}</div>
                </div>
                <div className="htb-member-stats">
                  <div className="htb-member-stat">
                    <Zap size={16} />
                    <span>{member.points || 0} pts</span>
                  </div>
                  <div className="htb-member-stat">
                    <Award size={16} />
                    <span>{member.personallySolvedCount || member.personallySolvedChallenges?.length || 0} solved</span>
                  </div>
                  <div className="htb-member-stat">
                    <Lock size={16} />
                    <span>{member.unlockedHints?.length || 0} hints</span>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {team.members.length === 0 && (
            <div className="htb-empty-state">
              <Users size={48} />
              <p>No members in this team yet</p>
            </div>
          )}
        </motion.div>

        {team.members.some(m => m.unlockedHints && m.unlockedHints.length > 0) && (
          <motion.div 
            className="htb-team-section"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            <h2 className="htb-section-title">
              <span className="htb-title-line"></span>
              Unlocked Hints
            </h2>
            <div className="htb-hints-list">
              {team.members.map((member, memberIndex) => (
                member.unlockedHints && member.unlockedHints.length > 0 && (
                  <motion.div 
                    key={member._id}
                    className="htb-member-hints-group"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.7 + memberIndex * 0.1 }}
                  >
                    <div className="htb-member-hints-header">
                      <Users size={18} />
                      <span>{member.username}</span>
                    </div>
                    <div className="htb-hints-grid">
                      {member.unlockedHints.map((hint, idx) => (
                        <motion.div 
                          key={idx}
                          className="htb-hint-card"
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: 0.8 + idx * 0.05 }}
                          whileHover={{ scale: 1.02 }}
                        >
                          <div className="htb-hint-challenge">
                            <span className="htb-hint-challenge-name">
                              {hint.challengeName || 'Unknown Challenge'}
                            </span>
                            <span className="htb-hint-index">
                              Hint #{hint.hintIndex + 1}
                            </span>
                          </div>
                          <div className="htb-hint-cost">
                            -{hint.cost || 0} pts
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

export default TeamDetails;
