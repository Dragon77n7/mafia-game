const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const { generateRoomCode, assignRoles, checkWinCondition, resolveNight, resolveDayVote } = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '../client')));

const rooms = {};

// ── Znajdź lokalne IP ──────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── Helpers ────────────────────────────────────────────────
function log(tag, ...args) {
  const t = new Date().toTimeString().slice(0,8);
  console.log(`[${t}] ${tag}`, ...args);
}

function broadcast(roomCode, data, excludeId = null) {
  const room = rooms[roomCode];
  if (!room) return;
  room.players.forEach(p => {
    if (p.id !== excludeId && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(data));
    }
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function checkAllNightActionsComplete(roomCode) {
  const room = rooms[roomCode];
  if (!room) return false;
  const alive = room.players.filter(p => p.alive);
  const mafias  = alive.filter(p => p.role === 'mafia');
  const doctors = alive.filter(p => p.role === 'doctor');
  const police  = alive.filter(p => p.role === 'police');
  const mafiaOK  = mafias.every(m => room.nightActions.mafiaVotes[m.id] !== undefined);
  const doctorOK = doctors.length === 0 || room.nightActions.doctorSave !== undefined;
  const policeOK = police.every(c => room.nightActions.policeChecks[c.id] !== undefined);
  log('CHECK_NIGHT', `mafia:${mafiaOK} doctor:${doctorOK} police:${policeOK}`);
  return mafiaOK && doctorOK && policeOK;
}

function processNightEnd(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  log('NIGHT_END', `pokój ${roomCode}`);

  const result = resolveNight(room.nightActions, room.players);
  let killedPlayer = null;

  if (result.killed) {
    const p = room.players.find(pl => pl.id === result.killed);
    if (p) { p.alive = false; killedPlayer = { id: p.id, name: p.name, role: p.role }; }
  }

  // Wyniki policji
  room.players.filter(p => p.role === 'police' && p.alive).forEach(cop => {
    if (result.policeResults[cop.id]) {
      sendTo(cop.ws, { type: 'POLICE_RESULT', target: result.policeResults[cop.id] });
    }
  });

  // Powiadom zabitego
  if (killedPlayer) {
    const dead = room.players.find(p => p.id === killedPlayer.id);
    if (dead) sendTo(dead.ws, { type: 'YOU_DIED', role: dead.role });
    log('ZABITY', killedPlayer.name, `(${killedPlayer.role})`);
  }

  const win = checkWinCondition(room.players);
  if (win) { endGame(roomCode, win); return; }

  room.phase = 'day';
  room.dayVotes = {};
  room.chatMessages = [];

  log('FAZA', `→ DZIEŃ (pokój ${roomCode})`);
  const mafiaLeftNight = room.players.filter(p=>p.alive&&p.role==='mafia').length;
  broadcast(roomCode, {
    type: 'NIGHT_RESULT',
    killed: killedPlayer,
    saved: result.saved,
    phase: 'day',
    mafiaLeft: mafiaLeftNight,
    players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive })),
  });
}

function endGame(roomCode, winner) {
  const room = rooms[roomCode];
  if (!room) return;
  room.phase = 'ended';
  log('KONIEC_GRY', `zwycięzca: ${winner} (pokój ${roomCode})`);
  broadcast(roomCode, {
    type: 'GAME_OVER',
    winner,
    players: room.players.map(p => ({ id: p.id, name: p.name, role: p.role, alive: p.alive })),
  });
}

function startNight(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.phase = 'night';
  room.nightActions = { mafiaVotes: {}, policeChecks: {} };
  room.voteForVoting = {};
  log('FAZA', `→ NOC runda ${room.round} (pokój ${roomCode})`);

  room.players.filter(p => p.alive).forEach(p => {
    const mt = room.players.filter(m => m.role==='mafia' && m.id!==p.id && m.alive).map(m=>({id:m.id,name:m.name}));
    sendTo(p.ws, {
      type: 'NIGHT_START',
      round: room.round,
      role: p.role,
      mafiaTeam: p.role === 'mafia' ? mt : [],
      players: room.players.map(pl => ({ id: pl.id, name: pl.name, alive: pl.alive })),
    });
    log('  NIGHT_START →', p.name, `rola=${p.role}`);
  });
}

// ── WebSocket ──────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;
  let playerRoom = null;
  log('WS', 'Nowe połączenie');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    log('MSG ←', msg.type, msg.playerId || '', msg.name || '', msg.roomCode || '');

    switch (msg.type) {

      case 'CREATE_ROOM': {
        const code = generateRoomCode();
        playerId = 'p_' + Math.random().toString(36).substring(2, 8);
        playerRoom = code;
        rooms[code] = {
          players: [{ id: playerId, name: msg.name, ws, isHost: true, alive: true, role: null }],
          hostId: playerId,
          phase: 'lobby',
          round: 0,
          settings: { rounds: 3, mafiaCount: 1, policeCount: 1, doctorCount: 1 },
          nightActions: { mafiaVotes: {}, policeChecks: {} },
          dayVotes: {},
          voteForVoting: {},
          chatMessages: [],
        };
        log('CREATE_ROOM', `kod=${code} host=${msg.name} id=${playerId}`);
        sendTo(ws, { type: 'ROOM_CREATED', roomCode: code, playerId, isHost: true });
        break;
      }

      case 'JOIN_ROOM': {
        const room = rooms[msg.roomCode];
        if (!room) { sendTo(ws, { type: 'ERROR', msg: 'Pokój nie istnieje' }); break; }

        // ── REJOIN (gracz wraca po przejściu na game.html) ──
        if (msg.playerId) {
          const existing = room.players.find(p => p.id === msg.playerId);
          if (existing) {
            existing.ws = ws;
            playerId = existing.id;
            playerRoom = msg.roomCode;
            log('REJOIN', existing.name, `faza=${room.phase} rola=${existing.role}`);
            sendTo(ws, { type: 'REJOIN_OK', playerId, roomCode: msg.roomCode, isHost: existing.isHost });

            if (room.phase === 'night') {
              const mt = room.players.filter(m=>m.role==='mafia'&&m.id!==playerId&&m.alive).map(m=>({id:m.id,name:m.name}));
              sendTo(ws, {
                type: 'NIGHT_START', round: room.round, role: existing.role,
                mafiaTeam: existing.role==='mafia' ? mt : [],
                players: room.players.map(pl=>({id:pl.id,name:pl.name,alive:pl.alive})),
              });
            } else if (room.phase === 'day') {
              sendTo(ws, {
                type: 'NIGHT_RESULT', killed: null, saved: false, phase: 'day',
                players: room.players.map(p=>({id:p.id,name:p.name,alive:p.alive})),
              });
            } else if (room.phase === 'voting') {
              sendTo(ws, {
                type: 'VOTING_STARTED',
                players: room.players.filter(p=>p.alive).map(p=>({id:p.id,name:p.name})),
              });
            }
            break;
          }
        }

        // ── Nowy gracz w lobby ──
        if (room.phase !== 'lobby') { sendTo(ws, { type: 'ERROR', msg: 'Gra już trwa' }); break; }
        if (room.players.find(p => p.name === msg.name)) { sendTo(ws, { type: 'ERROR', msg: 'Nazwa zajęta' }); break; }

        playerId = 'p_' + Math.random().toString(36).substring(2, 8);
        playerRoom = msg.roomCode;
        room.players.push({ id: playerId, name: msg.name, ws, isHost: false, alive: true, role: null });

        log('JOIN', msg.name, `id=${playerId} pokój=${msg.roomCode} graczy=${room.players.length}`);
        sendTo(ws, { type: 'ROOM_JOINED', roomCode: msg.roomCode, playerId, isHost: false });
        broadcast(msg.roomCode, {
          type: 'LOBBY_UPDATE',
          players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
        });
        break;
      }

      case 'UPDATE_SETTINGS': {
        const room = rooms[playerRoom];
        if (!room || room.hostId !== playerId) break;
        room.settings = { ...room.settings, ...msg.settings };
        log('SETTINGS', JSON.stringify(room.settings));
        broadcast(playerRoom, { type: 'SETTINGS_UPDATE', settings: room.settings });
        break;
      }

      case 'START_GAME': {
        const room = rooms[playerRoom];
        if (!room || room.hostId !== playerId) break;
        if (room.players.length < 3) { sendTo(ws, { type: 'ERROR', msg: 'Potrzeba min. 3 graczy' }); break; }
        const total = room.settings.mafiaCount + room.settings.policeCount + room.settings.doctorCount;
        if (total >= room.players.length) { sendTo(ws, { type: 'ERROR', msg: 'Za dużo ról dla tej liczby graczy' }); break; }

        const withRoles = assignRoles(room.players, room.settings);
        room.players = withRoles.map(p => ({ ...p, ws: room.players.find(rp => rp.id === p.id).ws }));
        room.round = 1;

        log('START_GAME', `pokój=${playerRoom} graczy=${room.players.length}`);
        room.players.forEach(p => log('  ROLA', p.name, '→', p.role));

        room.players.forEach(p => {
          const mt = room.players.filter(m=>m.role==='mafia'&&m.id!==p.id).map(m=>({id:m.id,name:m.name}));
          sendTo(p.ws, {
            type: 'GAME_STARTED',
            role: p.role, playerId: p.id, phase: 'night', round: 1,
            mafiaTeam: p.role === 'mafia' ? mt : [],
            players: room.players.map(pl => ({ id: pl.id, name: pl.name, alive: pl.alive })),
          });
          log('  GAME_STARTED →', p.name, `(${p.role})`);
        });

        room.phase = 'night';
        room.nightActions = { mafiaVotes: {}, policeChecks: {} };
        break;
      }

      case 'MAFIA_VOTE': {
        const room = rooms[playerRoom];
        if (!room || room.phase !== 'night') break;
        const voter = room.players.find(p => p.id === playerId);
        if (!voter || voter.role !== 'mafia' || !voter.alive) break;
        room.nightActions.mafiaVotes[playerId] = msg.targetId;
        const target = room.players.find(p => p.id === msg.targetId);
        log('MAFIA_VOTE', voter.name, '→', target?.name);

        const mafias = room.players.filter(p => p.role === 'mafia' && p.alive);
        mafias.forEach(m => sendTo(m.ws, {
          type: 'MAFIA_VOTES_UPDATE',
          votes: room.nightActions.mafiaVotes,
          voterNames: Object.fromEntries(
            Object.entries(room.nightActions.mafiaVotes).map(([vid, tid]) => {
              const v = room.players.find(p=>p.id===vid);
              const t = room.players.find(p=>p.id===tid);
              return [vid, { voterName: v?.name, targetName: t?.name }];
            })
          ),
        }));
        if (checkAllNightActionsComplete(playerRoom)) processNightEnd(playerRoom);
        break;
      }

      case 'DOCTOR_SAVE': {
        const room = rooms[playerRoom];
        if (!room || room.phase !== 'night') break;
        const doc = room.players.find(p => p.id === playerId);
        if (!doc || doc.role !== 'doctor' || !doc.alive) break;
        room.nightActions.doctorSave = msg.targetId;
        const target = room.players.find(p => p.id === msg.targetId);
        log('DOCTOR_SAVE', doc.name, '→', target?.name);
        sendTo(ws, { type: 'DOCTOR_ACK' });
        if (checkAllNightActionsComplete(playerRoom)) processNightEnd(playerRoom);
        break;
      }

      case 'POLICE_CHECK': {
        const room = rooms[playerRoom];
        if (!room || room.phase !== 'night') break;
        const cop = room.players.find(p => p.id === playerId);
        if (!cop || cop.role !== 'police' || !cop.alive) break;
        room.nightActions.policeChecks[playerId] = msg.targetId;
        const target = room.players.find(p => p.id === msg.targetId);
        log('POLICE_CHECK', cop.name, '→', target?.name, `(${target?.role})`);
        sendTo(ws, { type: 'POLICE_RESULT', target: { targetId: msg.targetId, role: target?.role, name: target?.name } });
        if (checkAllNightActionsComplete(playerRoom)) processNightEnd(playerRoom);
        break;
      }

      case 'VOTE_FOR_VOTING': {
        const room = rooms[playerRoom];
        if (!room || room.phase !== 'day') break;
        const voter = room.players.find(p=>p.id===playerId);
        if (!voter || !voter.alive) break;

        room.voteForVoting[playerId] = true;
        const aliveCount = room.players.filter(p=>p.alive).length;
        const votingCount = Object.keys(room.voteForVoting).length;
        const needed = Math.ceil(aliveCount / 2);

        log('VOTE_FOR_VOTING', voter.name, `${votingCount}/${aliveCount} (potrzeba ${needed})`);

        broadcast(playerRoom, {
          type: 'VOTING_POLL_UPDATE',
          count: votingCount,
          total: aliveCount,
          needed,
          voters: Object.keys(room.voteForVoting).map(id => room.players.find(p=>p.id===id)?.name),
        });

        if (votingCount >= needed) {
          room.phase = 'voting';
          room.dayVotes = {};
          room.voteForVoting = {};
          log('FAZA', `→ GŁOSOWANIE (pokój ${playerRoom})`);
          broadcast(playerRoom, {
            type: 'VOTING_STARTED',
            players: room.players.filter(p=>p.alive).map(p=>({id:p.id,name:p.name})),
          });
        }
        break;
      }

      case 'START_VOTING': {
        const room = rooms[playerRoom];
        if (!room || room.phase !== 'day') break;
        // Zostaw jako alias — nieużywane ale nie psuj
        break;
      }

      case 'DAY_VOTE': {
        const room = rooms[playerRoom];
        if (!room || room.phase !== 'voting') break;
        const voter = room.players.find(p => p.id === playerId);
        if (!voter || !voter.alive) break;
        room.dayVotes[playerId] = msg.targetId;
        const target = room.players.find(p => p.id === msg.targetId);
        log('DAY_VOTE', voter.name, '→', target?.name);

        const aliveCount = room.players.filter(p=>p.alive).length;
        broadcast(playerRoom, { type: 'VOTE_UPDATE', voteCount: Object.keys(room.dayVotes).length, total: aliveCount });

        if (Object.keys(room.dayVotes).length >= aliveCount) {
          const eliminated = resolveDayVote(room.dayVotes, room.players);
          let eliminatedPlayer = null;
          if (eliminated) {
            const ep = room.players.find(p=>p.id===eliminated);
            if (ep) {
              ep.alive = false;
              eliminatedPlayer = { id: ep.id, name: ep.name, role: ep.role };
              sendTo(ep.ws, { type: 'YOU_DIED', role: ep.role });
              log('ELIMINACJA', ep.name, `(${ep.role})`);
            }
          } else {
            log('GŁOSOWANIE', 'Remis — nikt nie odpada');
          }

          const win = checkWinCondition(room.players);
          if (win) { endGame(playerRoom, win); break; }

          room.round++;
          const mafiaLeft = room.players.filter(p=>p.alive&&p.role==='mafia').length;
          broadcast(playerRoom, {
            type: 'DAY_RESULT',
            eliminated: eliminatedPlayer, tie: !eliminated,
            mafiaLeft, nextPhase: 'night', round: room.round,
            players: room.players.map(p=>({id:p.id,name:p.name,alive:p.alive})),
          });
          startNight(playerRoom);
        }
        break;
      }

      case 'MAFIA_CHAT': {
        const room = rooms[playerRoom];
        if (!room) break;
        const sender = room.players.find(p=>p.id===playerId);
        if (!sender || sender.role !== 'mafia' || !sender.alive) break;
        const mafiaMsg = { senderId: playerId, senderName: sender.name, text: msg.text, time: Date.now() };
        log('MAFIA_CHAT', sender.name+':', msg.text);
        room.players.filter(p=>p.role==='mafia').forEach(m => {
          sendTo(m.ws, { type: 'MAFIA_CHAT', ...mafiaMsg });
        });
        break;
      }

      case 'CHAT_MESSAGE': {
        const room = rooms[playerRoom];
        if (!room || room.phase !== 'day') break;
        const sender = room.players.find(p=>p.id===playerId);
        if (!sender || !sender.alive) break;
        const chatMsg = { senderId: playerId, senderName: sender.name, text: msg.text, time: Date.now() };
        room.chatMessages.push(chatMsg);
        broadcast(playerRoom, { type: 'CHAT_MESSAGE', ...chatMsg });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!playerRoom || !playerId) return;
    const room = rooms[playerRoom];
    if (!room) return;
    const p = room.players.find(p=>p.id===playerId);
    log('DISCONNECT', p?.name || playerId);
    // Nie usuwaj gracza — może się zreconnectować
    if (p) p.ws = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     🎭  MAFIA — SERWER URUCHOMIONY     ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Lokalnie:  http://localhost:${PORT}       ║`);
  console.log(`║  Sieć/tel:  http://${ip}:${PORT}  ║`);
  console.log('║                                        ║');
  console.log('║  Gracze w tej samej sieci Wi-Fi        ║');
  console.log('║  mogą wejść przez adres "Sieć/tel"     ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
});
