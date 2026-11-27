const { loadScoreboard } = require('./standings');

// Ranked teams. Pass a freeze time to rank as of that moment.
async function aggregateTeamStandings(freezeTime = null, limit = null) {
  const standings = (await loadScoreboard({ cutoff: freezeTime })).teamStandings();
  return limit ? standings.slice(0, limit) : standings;
}

module.exports = { aggregateTeamStandings };
