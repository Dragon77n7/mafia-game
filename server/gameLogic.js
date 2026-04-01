// gameLogic.js — logika gry Mafia

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function assignRoles(players, settings) {
  const { mafiaCount, policeCount, doctorCount } = settings;
  const roles = [];
  for (let i = 0; i < mafiaCount; i++) roles.push('mafia');
  for (let i = 0; i < policeCount; i++) roles.push('police');
  for (let i = 0; i < doctorCount; i++) roles.push('doctor');
  while (roles.length < players.length) roles.push('civilian');

  // Fisher-Yates shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return players.map((p, i) => ({ ...p, role: roles[i], alive: true }));
}

function checkWinCondition(players) {
  const alive = players.filter(p => p.alive);
  const mafiaAlive = alive.filter(p => p.role === 'mafia').length;
  const townAlive = alive.filter(p => p.role !== 'mafia').length;

  if (mafiaAlive === 0) return 'town';
  if (mafiaAlive >= townAlive) return 'mafia';
  return null;
}

function resolveNight(nightActions, players) {
  const { mafiaVotes, doctorSave, policeChecks } = nightActions;
  const result = { killed: null, saved: false, policeResults: {} };

  // Mafia kill — majority vote
  if (mafiaVotes && Object.keys(mafiaVotes).length > 0) {
    const voteCounts = {};
    Object.values(mafiaVotes).forEach(target => {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    });
    const maxVotes = Math.max(...Object.values(voteCounts));
    const topTargets = Object.keys(voteCounts).filter(t => voteCounts[t] === maxVotes);
    if (topTargets.length === 1) {
      result.killed = topTargets[0];
    }
    // tie = no kill
  }

  // Doctor save
  if (doctorSave && doctorSave === result.killed) {
    result.saved = true;
    result.killed = null;
  }

  // Police checks
  if (policeChecks) {
    Object.entries(policeChecks).forEach(([officerId, targetId]) => {
      const target = players.find(p => p.id === targetId);
      if (target) {
        result.policeResults[officerId] = { targetId, role: target.role, name: target.name };
      }
    });
  }

  return result;
}

function resolveDayVote(votes, players) {
  const voteCounts = {};
  Object.values(votes).forEach(target => {
    if (target) voteCounts[target] = (voteCounts[target] || 0) + 1;
  });

  if (Object.keys(voteCounts).length === 0) return null;

  const maxVotes = Math.max(...Object.values(voteCounts));
  const topTargets = Object.keys(voteCounts).filter(t => voteCounts[t] === maxVotes);

  if (topTargets.length !== 1) return null; // remis
  return topTargets[0];
}

module.exports = { generateRoomCode, assignRoles, checkWinCondition, resolveNight, resolveDayVote };
