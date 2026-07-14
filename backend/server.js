const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let db;
try { db = JSON.parse(fs.readFileSync('database.json', 'utf8')); } 
catch(e) { console.error("🔥 database.json 파일 문법 에러!:", e); }

const rooms = {};
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// --- 헬퍼 함수 ---
function getDistance(x1, y1, x2, y2) { 
    let d = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); 
    return isNaN(d) ? 1 : d; 
}

function pDistance(x, y, x1, y1, x2, y2) {
    let A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
    let dot = A * C + B * D;
    let len_sq = C * C + D * D;
    let param = -1;
    if (len_sq !== 0) param = dot / len_sq;
    else return Math.sqrt(A*A + B*B) || 999; 
    let xx, yy;
    if (param < 0) { xx = x1; yy = y1; } 
    else if (param > 1) { xx = x2; yy = y2; } 
    else { xx = x1 + param * C; yy = y1 + param * D; }
    let dx = x - xx, dy = y - yy;
    let d = Math.sqrt(dx * dx + dy * dy);
    return isNaN(d) ? 999 : d;
}

function getRole(posId) {
    if (!posId) return 'MF';
    if (posId.includes('B')) return 'DF'; 
    const fwList = ['ST', 'LS', 'RS', 'CF', 'LF', 'RF', 'LW', 'RW'];
    if (fwList.includes(posId) || posId.includes('T') || posId.includes('W')) return 'FW'; 
    return 'MF'; 
}

function resetPositions(state, kickoffTeam) {
    state.ball = { x: 50, y: 50, vx: 0, vy: 0 };
    state.phase = 'play';
    state.isPaused = false;
    state.isKickoff = true;
    state.kickoffTeam = kickoffTeam;
    state.passTargetId = null; 
    state.players.forEach(p => { p.x = p.baseX; p.y = p.baseY; p.cooldown = 0; });
    
    const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW') || state.players.find(p => p.team === kickoffTeam);
    if (striker) { 
        striker.x = kickoffTeam === 1 ? 47 : 53; 
        striker.y = 50; 
        state.kickoffStrikerId = striker.id;
    } else {
        state.kickoffStrikerId = null;
    }
}

function emitUpdate(roomCode, state) {
    let totalTicks = state.ticks;
    let gameSeconds = (totalTicks / 10) * (db.settings.gameMinutesPerHalf * 60 / db.settings.halfDurationRealSeconds);
    if (state.half === 2) gameSeconds += 45 * 60; 
    io.to(roomCode).emit('matchUpdate', {
        gameSeconds: gameSeconds, event: state.eventText, ball: state.ball, players: state.players, score: state.score
    });
}

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = { players: { [socket.id]: { id: 'player1', ready: false, team: [] } }, settings: { timer: db.settings.draftTimers[1], formation: null }, state: 'lobby', availablePlayers: [...db.players] };
        socket.join(roomCode); socket.emit('roomCreated', roomCode, db);
    });
    socket.on('joinRoom', (roomCode) => {
        if (roomCode === '000000') {
            const testRoomCode = 'TEST_' + generateRoomCode(); 
            rooms[testRoomCode] = {
                players: {
                    'dummy_ai': { id: 'player1', ready: true, team: [], formation: '4-3-3' },
                    [socket.id]: { id: 'player2', ready: false, team: [], formation: null }
                },
                settings: { timer: db.settings.draftTimers[1], formation: null },
                state: 'lobby',
                availablePlayers: [...db.players],
                isTestMode: true 
            };
            socket.join(testRoomCode);
            socket.emit('roomJoined', testRoomCode, db); 
            setTimeout(() => { io.to(testRoomCode).emit('playerJoinedLobby'); }, 500); 
            return;
        }

        if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length < 2) {
            rooms[roomCode].players[socket.id] = { id: 'player2', ready: false, team: [] };
            socket.join(roomCode); socket.emit('roomJoined', roomCode, db); io.to(roomCode).emit('playerJoinedLobby'); 
        } else { 
            socket.emit('error', '방이 가득 찼거나 존재하지 않는 코드입니다.'); 
        }
    });
    socket.on('setTimer', (roomCode, timerValue) => { if (rooms[roomCode]) { rooms[roomCode].settings.timer = timerValue; socket.to(roomCode).emit('timerUpdated', timerValue); } });
    socket.on('playerReady', (roomCode, formationId) => {
        const room = rooms[roomCode]; if(!room || !room.players[socket.id]) return; 
        room.players[socket.id].formation = formationId; room.players[socket.id].ready = true;
        const playersArr = Object.values(room.players);
        
        if (playersArr.every(p => p.ready) && playersArr.length === 2) {
            if (room.isTestMode) {
                playersArr.forEach(pData => {
                    for (let i = 0; i < 10; i++) {
                        if (room.availablePlayers.length === 0) break;
                        let idx = Math.floor(Math.random() * room.availablePlayers.length);
                        pData.team.push({ slot: i, player: room.availablePlayers.splice(idx, 1)[0] });
                    }
                });
                startMatchPhase(roomCode, false);
            } else {
                startDraftPhase(roomCode);
            }
        }
    });
    socket.on('playerPlaced', (roomCode, slotId, playerInfo) => {
        const room = rooms[roomCode]; if(!room || !room.currentDraft) return;
        const isP1 = room.players[socket.id].id === 'player1';
        const expectedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
        if (!playerInfo || playerInfo.id !== expectedPlayer.id || (isP1 && room.currentDraft.p1Placed) || (!isP1 && room.currentDraft.p2Placed)) return;
        room.players[socket.id].team.push({ slot: slotId, player: playerInfo });
        room.currentDraft.answers++;
        if (isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
        if (room.currentDraft.answers === 2) { clearTimeout(room.draftTimeout); room.draftCount++; nextDraftTurn(roomCode); }
    });
    socket.on('swapPlayers', (roomCode, teamId, id1, id2) => {
        const room = rooms[roomCode]; if(!room || !room.matchState) return;
        const p1 = room.matchState.players.find(p => p.team === teamId && p.id == id1);
        const p2 = room.matchState.players.find(p => p.team === teamId && p.id == id2);
        if(p1 && p2) {
            let tempX = p1.baseX, tempY = p1.baseY, tempRole = p1.role;
            p1.baseX = p2.baseX; p1.baseY = p2.baseY; p1.role = p2.role; p1.x = p1.baseX; p1.y = p1.baseY;
            p2.baseX = tempX; p2.baseY = tempY; p2.role = tempRole; p2.x = p2.baseX; p2.y = p2.baseY;
        }
    });
});

function startDraftPhase(roomCode) {
    const room = rooms[roomCode]; room.state = 'draft'; room.draftCount = 0;
    io.to(roomCode).emit('startDraft'); nextDraftTurn(roomCode);
}

function nextDraftTurn(roomCode) {
    const room = rooms[roomCode];
    if (room.draftCount >= 10) { startMatchPhase(roomCode, false); return; }
    function pullRandomPlayer() {
        if(room.availablePlayers.length === 0) return null;
        const idx = Math.floor(Math.random() * room.availablePlayers.length);
        return room.availablePlayers.splice(idx, 1)[0];
    }
    const p1Player = pullRandomPlayer(), p2Player = pullRandomPlayer();
    room.currentDraft = { p1: p1Player, p2: p2Player, answers: 0, p1Placed: false, p2Placed: false };
    io.to(roomCode).emit('draftPlayer', { p1: p1Player, p2: p2Player, timeLimit: room.settings.timer });
    
    const currentTurn = room.draftCount; 
    room.draftTimeout = setTimeout(() => { 
        if(!room || !room.currentDraft || room.draftCount !== currentTurn) return;
        Object.keys(room.players).forEach(pId => {
            const pData = room.players[pId]; const isP1 = pData.id === 'player1';
            const hasPlaced = isP1 ? room.currentDraft.p1Placed : room.currentDraft.p2Placed;
            if (!hasPlaced) {
                const filledSlots = pData.team.map(t => parseInt(t.slot)); let emptySlot = -1;
                for(let i = 0; i < 10; i++) { if(!filledSlots.includes(i)) { emptySlot = i; break; } }
                if(emptySlot !== -1) {
                    const assignedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
                    pData.team.push({ slot: emptySlot, player: assignedPlayer });
                    io.to(pId).emit('autoPlaced', emptySlot, assignedPlayer); 
                }
                room.currentDraft.answers++;
                if(isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
            }
        });
        if (room.currentDraft.answers >= 2) { room.draftCount++; nextDraftTurn(roomCode); }
    }, room.settings.timer * 1000 + 500); 
}

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode]; room.state = 'match'; room.code = roomCode; 
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]], p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions, p2Formation = db.formations[p2Data.formation].positions;
        const gkStats = { spd: 85, sht: 85, pas: 80 }; 

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, 
            phase: 'play', setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이", isPaused: false, throwerId: null, gkHolder: null, passTargetId: null,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => { return { ...t.player, team: 1, role: getRole(p1Formation[t.slot].id), posId: p1Formation[t.slot].id, x: p1Formation[t.slot].x / 2, y: p1Formation[t.slot].y, baseX: p1Formation[t.slot].x / 2, baseY: p1Formation[t.slot].y, cooldown: 0 }; }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats, cooldown: 0 },
                ...p2Data.team.map((t, idx) => { return { ...t.player, team: 2, role: getRole(p2Formation[t.slot].id), posId: p2Formation[t.slot].id, x: 100 - (p2Formation[t.slot].x / 2), y: 100 - p2Formation[t.slot].y, baseX: 100 - (p2Formation[t.slot].x / 2), baseY: 100 - p2Formation[t.slot].y, cooldown: 0 }; }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', posId:'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats, cooldown: 0 }
            ]
        };
    } else {
            room.matchState.half = 2; room.matchState.ticks = 0; room.matchState.phase = 'play'; room.matchState.isPaused = false; room.matchState.passTargetId = null;
            room.matchState.players.forEach(p => {
            p.baseX = 100 - p.baseX;
            p.baseY = 100 - p.baseY;
        });
    }

    resetPositions(room.matchState, isSecondHalf ? 2 : 1);  
    io.to(roomCode).emit('matchStarted', room.matchState); io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        try {
            const state = room.matchState;
            if (state.isPaused) return; 
            state.ticks++;

            if (isNaN(state.ball.x) || isNaN(state.ball.y)) { state.ball.x = 50; state.ball.y = 50; state.ball.vx = 0; state.ball.vy = 0; }
            state.players.forEach(p => {
                if (isNaN(p.x) || isNaN(p.y)) { p.x = p.baseX; p.y = p.baseY; }
                if (isNaN(p.cooldown)) p.cooldown = 0;
            });

            // --- 1. 세트피스 및 골키퍼 배급 ---
            if (state.phase !== 'play') {
                if (state.phase === 'gk_hold' && state.gkHolder) {
                    state.ball.x = state.gkHolder.x + (state.gkHolder.team === 1 ? 1.5 : -1.5); 
                    state.ball.y = state.gkHolder.y; state.ball.vx = 0; state.ball.vy = 0;
                }

                state.setPieceTimer--;
                if (state.setPieceTimer <= 0) {
                    io.to(roomCode).emit('playSound', 'kick');
                    
                    if (state.phase === 'gk_hold' && state.gkHolder) {
                        let p = state.gkHolder;
                        let bestMate = null; let maxScore = -999;
                        let dir = (p.team === 1) ? 1 : -1;
                        
                        state.players.forEach(m => {
                            if (m.team === p.team && m.role !== 'GK') {
                                let minEnemyDist = Infinity;
                                state.players.forEach(e => { if (e.team !== p.team) { let d = getDistance(m.x, m.y, e.x, e.y); if(d < minEnemyDist) minEnemyDist = d; } });
                                
                                let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x);
                                let score = minEnemyDist * 10; 
                                
                                if (m.y < 20 || m.y > 80) score += 200; 
                                if (forwardDist > 40) score += 150;     
                                
                                if (score > maxScore && minEnemyDist > 12) { maxScore = score; bestMate = m; }
                            }
                        });

                        if (bestMate) {
                            let d = getDistance(p.x, p.y, bestMate.x, bestMate.y) || 1;
                            let passPower = 6.5; 
                            state.ball.vx = ((bestMate.x - p.x) / d) * passPower; 
                            state.ball.vy = ((bestMate.y - p.y) / d) * passPower;
                            state.passTargetId = bestMate.id; 
                            
                            if (d > 35) {
                                state.ball.airTicks = Math.max(4, Math.floor(d / 4.5));
                                state.eventText = "🧤 키퍼 롱 패스 전개!";
                            }
                        } else {
                            state.ball.vx = dir * 7.5; state.ball.vy = (p.y > 50) ? 3.5 : -3.5;
                            state.ball.airTicks = 5;
                        }
                        p.cooldown = 20; 
                    } 
                    else {
                        let dir = (state.possessionTeam === 1) ? 1 : -1;
                        if (state.phase === 'throw_in') {
                            let fieldPlayers = state.players.filter(p => p.role !== 'GK');
                            let mates = fieldPlayers.filter(p => p.team === state.possessionTeam && p.id !== state.throwerId);
                            mates.sort((a,b) => getDistance(state.ball.x, state.ball.y, a.x, a.y) - getDistance(state.ball.x, state.ball.y, b.x, b.y));
                            let target = mates[0];
                            if(target) {
                                let dist = getDistance(state.ball.x, state.ball.y, target.x, target.y) || 1;
                                state.ball.vx = ((target.x - state.ball.x) / dist) * 3.0; state.ball.vy = ((target.y - state.ball.y) / dist) * 3.0;
                                state.passTargetId = target.id;
                                
                                if (dist > 15) {
                                    state.ball.airTicks = Math.max(2, Math.floor(dist / 2.2));
                                    state.eventText = "🙌 롱 스로인!";
                                }
                            } else { state.ball.vx = dir * 2.5; state.ball.vy = 0; }
                        } 
                        else if (state.phase === 'corner') {
                            let targetX = (state.possessionTeam === 1) ? 90 : 10;
                            let targetY = 50 + (Math.random() - 0.5) * 15;
                            let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                            state.ball.vx = ((targetX - state.ball.x) / dist) * 4.8; state.ball.vy = ((targetY - state.ball.y) / dist) * 4.8;
                            
                            state.ball.airTicks = Math.max(4, Math.floor(dist / 4.0));
                            state.eventText = "🎯 코너킥 크로스!";
                        } 
                        else if (state.phase === 'goal_kick') {
                            let targetX = state.ball.x + dir * 45;
                            let targetY = 30 + Math.random() * 40; 
                            let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                            state.ball.vx = ((targetX - state.ball.x) / dist) * 5.5; state.ball.vy = ((targetY - state.ball.y) / dist) * 5.5;
                            
                            state.ball.airTicks = Math.max(5, Math.floor(dist / 4.2));
                            state.eventText = "🚀 골킥 롱 볼 전개!";
                        } 
                        else if (state.phase === 'free_kick') {
                            let targetX = state.ball.x + dir * 35;
                            let targetY = 50 + (Math.random() - 0.5) * 30;
                            let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                            state.ball.vx = ((targetX - state.ball.x) / dist) * 4.5; state.ball.vy = ((targetY - state.ball.y) / dist) * 4.5;
                            
                            state.ball.airTicks = Math.max(3, Math.floor(dist / 3.8));
                            state.eventText = "📐 프리킥 크로스!";
                        }
                    }
                    state.phase = 'play'; state.gkHolder = null;
                }
                if (state.phase !== 'play' && state.phase !== 'gk_hold') { emitUpdate(roomCode, state); return; }
            }

            // --- 2. 물리 연산 ---
            if (state.phase === 'play') {
                state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
                state.ball.vx *= 0.94; state.ball.vy *= 0.94; 
                if (state.ball.airTicks && state.ball.airTicks > 0) {
                    state.ball.airTicks--;
                }
                let speedSq = state.ball.vx ** 2 + state.ball.vy ** 2;
                if (speedSq > 64) {
                    let speed = Math.sqrt(speedSq);
                    state.ball.vx = (state.ball.vx / speed) * 8;
                    state.ball.vy = (state.ball.vy / speed) * 8;
                }
            }

            // --- 3. 소유권 계산 ---
            let distArr1 = [], distArr2 = [];
            state.players.forEach(p => {
                let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                let strayDist = getDistance(p.x, p.y, p.baseX, p.baseY) || 0;
                let pressScore = dist;
                
                if (strayDist > 15) pressScore += (strayDist - 15) * 2; 
                if (strayDist > 25) pressScore += 500; 

                if(p.role !== 'GK') { if (p.team === 1) distArr1.push({p, dist, pressScore, strayDist}); else distArr2.push({p, dist, pressScore, strayDist}); }
            });
            
            let minDist1 = distArr1.length > 0 ? Math.min(...distArr1.map(o => o.dist)) : Infinity;
            let minDist2 = distArr2.length > 0 ? Math.min(...distArr2.map(o => o.dist)) : Infinity;

            if(minDist1 < minDist2 && minDist1 < 10) state.possessionTeam = 1;
            else if(minDist2 <= minDist1 && minDist2 < 10) state.possessionTeam = 2;
            
            const attTeam = state.possessionTeam;

            // --- 4. 공격 지향형 오프더볼 및 유기적 침투 AI ---
            let ballCarrier = state.players.find(b => b.team === attTeam && getDistance(b.x, b.y, state.ball.x, state.ball.y) < 6);

            distArr1.sort((a,b) => a.dist - b.dist);
            distArr2.sort((a,b) => a.dist - b.dist);

            let defLine1 = 15, defLine2 = 85; 
            state.players.forEach(p => {
                if (p.role === 'DF') {
                    if (p.team === 1 && p.x > defLine1) defLine1 = p.x;
                    if (p.team === 2 && p.x < defLine2) defLine2 = p.x;
                }
            });

            state.players.forEach(p => {
                if (p.cooldown > 0) p.cooldown--;
                
                let targetX = p.baseX, targetY = p.baseY;
                let dir = (p.team === 1) ? 1 : -1;
                let targetGoalX = (p.team === 1) ? 100 : 0;
                let isPressing = false;
                p.isMakingRun = false;
                
                if (state.phase !== 'play' || state.setPieceTimer > 0) {
                    if (p.role === 'GK') { targetX = (p.team===1?5:95); targetY = 50; }
                    else if (state.phase === 'throw_in' && p.id === state.throwerId) { targetX = state.ball.x; targetY = state.ball.y; }
                    else { targetX = (p.team === 1) ? p.baseX * 0.8 : 100 - ((100 - p.baseX) * 0.8); targetY = p.baseY; }
                } 
                else if (state.isKickoff) {
                    if (p.id === state.kickoffStrikerId) { targetX = 50; targetY = 50; isPressing = true; } 
                }
                else {
                    let myDistArr = (p.team === 1) ? distArr1 : distArr2;
                    let rankObj = myDistArr.find(obj => obj.p === p);
                    let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
                    let distToBall = rankObj ? rankObj.dist : 999;

                    if (attTeam !== p.team && p.role !== 'GK') {
                        let shiftY = (state.ball.y - 50) * 0.6; 
                        let blockY = p.baseY + shiftY;
                        let blockX = p.baseX;
                        
                        if (p.role === 'FW') blockX = state.ball.x - (dir * 10);
                        else if (p.role === 'MF') blockX = Math.max(20, Math.min(80, state.ball.x - (dir * 15)));
                        else if (p.role === 'DF') blockX = Math.max(8, Math.min(92, state.ball.x - (dir * 25)));

                        if (rank === 0 && distToBall < 25) { targetX = state.ball.x; targetY = state.ball.y; isPressing = true; } 
                        else if (rank === 1 && distToBall < 15) { targetX = state.ball.x - (dir*3); targetY = state.ball.y; isPressing = true; } 
                        else { targetX = blockX; targetY = blockY; }
                    }
                    else if (attTeam === p.team) {
                        if (state.passTargetId === p.id) {
                            targetX = state.ball.x; targetY = state.ball.y; isPressing = true; 
                        }
                        else if (p.role === 'GK') {
                            targetX = (p.team===1?15:85); targetY = 50; 
                        }
                        else if (ballCarrier && p.id === ballCarrier.id) {
                            targetX = targetGoalX; targetY = 50; 
                        }
                        else {
                            let inFinalThird = (p.team === 1 && state.ball.x > 60) || (p.team === 2 && state.ball.x < 40);
                            
                            if (inFinalThird) {
                                if (p.role === 'FW') {
                                    targetX = targetGoalX - (dir * (5 + Math.random()*5)); 
                                    targetY = 50 + ((p.baseY - 50) * 0.4); 
                                    p.isMakingRun = true;
                                } 
                                else if (p.role === 'MF') {
                                    targetX = targetGoalX - (dir * 18);
                                    targetY = state.ball.y + (p.baseY > 50 ? 10 : -10); 
                                    p.isMakingRun = true;
                                }
                                else if (p.role === 'DF') {
                                    if (p.baseY < 20 || p.baseY > 80) { targetX = state.ball.x + (dir * 10); targetY = p.baseY; p.isMakingRun = true;}
                                    else { targetX = 50 + (dir * 15); targetY = p.baseY; } 
                                }
                            } 
                            else {
                                let teamAdvance = (p.team === 1) ? state.ball.x - 20 : 120 - state.ball.x;
                                targetX = p.baseX + (dir * teamAdvance * 0.6);
                                targetY = p.baseY;

                                if (p.role === 'FW') {
                                    let offsideLine = (p.team === 1) ? defLine2 : defLine1;
                                    targetX = offsideLine - (dir * 1); 
                                    p.isMakingRun = true;
                                }
                                else if (p.role === 'MF' && ballCarrier) {
                                    let d = getDistance(p.x, p.y, ballCarrier.x, ballCarrier.y);
                                    if (d < 30) { targetX = ballCarrier.x + (dir * 15); targetY = ballCarrier.y + (p.baseY > 50 ? 15 : -15); }
                                }
                            }
                        }
                    }
                }

                state.players.forEach(other => {
                    if (other !== p && other.role !== 'GK' && getDistance(p.x, p.y, other.x, other.y) < 3) {
                        targetY += (targetY > 50) ? -4 : 4; 
                    }
                });

                targetX = isNaN(targetX) ? p.baseX : Math.max(2, Math.min(98, targetX)); 
                targetY = isNaN(targetY) ? p.baseY : Math.max(2, Math.min(98, targetY));
                
                let moveSpeed = ((p.stats && p.stats.spd ? p.stats.spd : 80) / 100); 
                if (isPressing || state.passTargetId === p.id || p.isMakingRun) moveSpeed *= 1.5; 
                else moveSpeed *= 1.0; 
                
                let distToTarget = getDistance(p.x, p.y, targetX, targetY) || 1;
                if (distToTarget > moveSpeed) {
                    p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                    p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
                } else { p.x = targetX; p.y = targetY; }
            });

            // --- 5. 슈팅 및 전진 패스 최우선 AI ---
            state.players.forEach(p => {
                let touchRadius = p.role === 'GK' ? 3.0 : 2.5; 
                let distToBallAct = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                let isBallInAir = (state.ball.airTicks && state.ball.airTicks > 0);
                let dir = (p.team === 1) ? 1 : -1;
                let targetGoalX = (p.team === 1) ? 100 : 0;

                if (!isBallInAir && distToBallAct < touchRadius && p.cooldown <= 0 && state.phase === 'play') {
                    state.lastTouchTeam = p.team;
                    state.passTargetId = null; 

                    if (state.isKickoff) {
                        if (p.team === state.kickoffTeam) {
                            let mates = state.players.filter(m => m.team === p.team && m.role !== 'GK' && m.id !== p.id);
                            let targetMate = mates[0];
                            if (targetMate) {
                                let d = getDistance(p.x, p.y, targetMate.x, targetMate.y) || 1;
                                state.ball.vx = ((targetMate.x - p.x) / d) * 3.5; state.ball.vy = ((targetMate.y - p.y) / d) * 3.5;
                                state.passTargetId = targetMate.id; io.to(roomCode).emit('playSound', 'kick'); p.cooldown = 12; state.isKickoff = false; return; 
                            }
                        }
                        state.isKickoff = false; 
                    }

                    if (p.role === 'GK') {
                        let isInBox = Math.abs(p.x - (p.team === 1 ? 0 : 100)) < 20 && p.y > 20 && p.y < 80;
                        if (isInBox && state.phase === 'play' && state.setPieceTimer <= 0) {
                            state.phase = 'gk_hold'; state.gkHolder = p; state.setPieceTimer = 15;
                            state.ball.vx = 0; state.ball.vy = 0; state.ball.x = p.x; state.ball.y = p.y; state.eventText = "키퍼 선방!"; p.cooldown = 20;
                        } else {
                            io.to(roomCode).emit('playSound', 'kick'); state.ball.vx = dir * 6.0; state.ball.vy = (p.y > 50) ? 3.0 : -3.0; p.cooldown = 15;
                        }
                        return;
                    }

                    let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);
                    let shotBlocked = false;
                    state.players.forEach(e => {
                        if (e.team !== p.team && e.role !== 'GK') {
                            if (pDistance(e.x, e.y, p.x, p.y, targetGoalX, 50) < 3.0 && 
                                ((dir===1 && e.x > p.x) || (dir===-1 && e.x < p.x))) shotBlocked = true;
                        }
                    });

                    if (distToGoal < 28 && !shotBlocked) {
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = ((p.stats && p.stats.sht ? p.stats.sht : 85) / 9.5);  
                        let aimY = 50 + (Math.random() > 0.5 ? 1 : -1) * 6; 
                        let dx = targetGoalX - p.x, dy = aimY - p.y; let d = Math.sqrt(dx*dx + dy*dy) || 1; 
                        state.ball.vx = (dx / d) * power; state.ball.vy = (dy / d) * power;
                        p.cooldown = 10; state.eventText = "🔥 슈팅 찬스!";
                        return;
                    }

                    let passOptions = [];
                    state.players.forEach(m => {
                        if (m.team === p.team && m.id !== p.id && m.role !== 'GK') {
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            if (dist < 4 || dist > 60) return; 

                            let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x); 
                            let laneBlocked = false;
                            let minEnemyDistToM = Infinity;
                            
                            state.players.forEach(e => {
                                if (e.team !== p.team && e.role !== 'GK') {
                                    if (pDistance(e.x, e.y, p.x, p.y, m.x, m.y) < 2.5) laneBlocked = true;
                                    let d2 = getDistance(m.x, m.y, e.x, e.y);
                                    if (d2 < minEnemyDistToM) minEnemyDistToM = d2;
                                }
                            });

                            let score = 0; let isThrough = false; let isLob = false;
                            
                            if (forwardDist < -5) score -= 400; 
                            else score += (forwardDist * 6); 

                            if (laneBlocked) score -= 1500; 
                            score += (minEnemyDistToM * 3); 

                            if (m.isMakingRun && forwardDist > 0 && minEnemyDistToM > 8 && !laneBlocked) {
                                score += 800; isThrough = true;
                            }

                            let inBoxX = (p.team === 1) ? m.x > 80 : m.x < 20;
                            if (inBoxX && Math.abs(m.y - 50) < 20 && !laneBlocked) {
                                score += 2000; 
                            }

                            if (dist > 35) {
                                if (forwardDist > 10 && minEnemyDistToM > 15) {
                                    score += 500; isLob = true; 
                                    if (laneBlocked) score += 2000; 
                                } else {
                                    score -= 5000; 
                                }
                            }

                            if (score > 0) passOptions.push({ mate: m, score: score, dist: dist, isThrough: isThrough, isLob: isLob });
                        }
                    });

                    passOptions.sort((a, b) => b.score - a.score);
                    let bestOption = passOptions.length > 0 ? passOptions[0] : null;

                    let ballSpeedSq = state.ball.vx ** 2 + state.ball.vy ** 2;
                    if (ballSpeedSq > 15) { 
                        state.ball.vx *= 0.2; state.ball.vy *= 0.2; state.ball.x = p.x; state.ball.y = p.y; p.cooldown = 0; return; 
                    }

                    if (bestOption && bestOption.score > 20) {
                        let targetX = bestOption.mate.x; let targetY = bestOption.mate.y;
                        
                        if (bestOption.isThrough) {
                            let spaceAhead = (p.team === 1) ? 100 - bestOption.mate.x : bestOption.mate.x - 0;
                            if (spaceAhead > 5) targetX += dir * 5; 
                        }

                        io.to(roomCode).emit('playSound', 'kick');
                        
                        let d = getDistance(p.x, p.y, targetX, targetY) || 1; 
                        let power = Math.min(d / 4.0, 8.5); 
                        if (bestOption.isLob) power *= 1.2;

                        state.ball.vx = ((targetX - p.x) / d) * power;
                        state.ball.vy = ((targetY - p.y) / d) * power; 
                        
                        if (bestOption.isLob) { state.ball.airTicks = Math.max(4, Math.floor(d / (power * 1.2))); state.eventText = "정확한 롱 패스!"; } 
                        else if (bestOption.isThrough) state.eventText = "킬 패스!";
                        else state.eventText = "전진 패스";
                        
                        state.passTargetId = bestOption.mate.id; 
                        p.cooldown = 8; 
                    } 
                    else {
                        let pSpeed = ((p.stats && p.stats.spd ? p.stats.spd : 80) / 100);
                        let nearestEnemy = state.players.find(e => e.team !== p.team && getDistance(e.x, e.y, p.x, p.y) < 8);
                        
                        if (nearestEnemy) {
                            let dx = p.x - nearestEnemy.x; let dy = p.y - nearestEnemy.y; let dist = Math.sqrt(dx*dx + dy*dy) || 1;
                            state.ball.vx = (dx / dist) * 1.5 + (dir * 1.2); state.ball.vy = (dy / dist) * 1.5; state.eventText = "탈압박!";
                        } else {
                            let centerDriveVy = (50 - p.y) * 0.08;
                            state.ball.vx = dir * pSpeed * 2.0; state.ball.vy = centerDriveVy; state.eventText = "폭풍 드리블!";
                        }
                        p.cooldown = 3; 
                    }
                }
            });

            // --- 6. 아웃 및 골 판정 ---
            if (state.ball.x <= 0) {
                if (state.ball.y > 38 && state.ball.y < 62) handleGoal(room, 2); 
                else setupSetPiece(state, state.lastTouchTeam === 1 ? 'corner' : 'goal_kick', 1);
            } 
            else if (state.ball.x >= 100) {
                if (state.ball.y > 38 && state.ball.y < 62) handleGoal(room, 1); 
                else setupSetPiece(state, state.lastTouchTeam === 2 ? 'corner' : 'goal_kick', 2);
            } 
            else if (state.ball.y <= 0 || state.ball.y >= 100) {
                setupSetPiece(state, 'throw_in', state.lastTouchTeam === 1 ? 2 : 1);
            }

            emitUpdate(roomCode, state);

        } catch (error) {
            console.error("🔥 인게임 연산 에러 발생!:", error);
        }
    }, 100); 
} 

function handleGoal(room, scoringTeam) {
    room.matchState.isPaused = true;
    room.matchState.ball.vx = 0; room.matchState.ball.vy = 0;
    room.matchState.score[`team${scoringTeam}`]++;
    room.matchState.eventText = "득점!!!";
    emitUpdate(room.code, room.matchState);
    io.to(room.code).emit('playSound', 'whistle');
    io.to(room.code).emit('goalScored', { team: scoringTeam, score: room.matchState.score });
    setTimeout(() => { if(room.matchState) { resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1); io.to(room.code).emit('playSound', 'whistle'); } }, 3000);
}

function setupSetPiece(state, type, sideTeam = 1) {
    state.phase = type; state.setPieceTimer = 15; state.ball.vx = 0; state.ball.vy = 0;
    let dir = sideTeam === 1 ? 1 : -1;

    if (type === 'throw_in') {
        state.players.forEach(p => { p.y = p.baseY; p.cooldown = 0; });
        state.eventText = "스로인"; state.ball.y = state.ball.y <= 0 ? 2 : 98;
        state.ball.x = Math.max(2, Math.min(98, state.ball.x)); 
        let fieldPlayers = state.players.filter(p => p.role !== 'GK');
        let thrower = fieldPlayers
            .filter(p => p.team === sideTeam)
            .reduce((prev, curr) => (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev));
        
        state.throwerId = thrower.id; state.possessionTeam = thrower.team;
        state.players.forEach(p => {
            if (p.role !== 'GK' && p.id !== thrower.id) {
                p.x = state.ball.x + (p.team === sideTeam ? (dir * -10) : (dir * 5)) + (Math.random()-0.5)*5;
                p.y = (p.baseY + state.ball.y) / 2 + (Math.random()-0.5)*10;
            }
        });
        thrower.x = state.ball.x; thrower.y = state.ball.y; thrower.cooldown = 15;
    } 
    else if (type === 'corner') {
        state.players.forEach(p => { p.y = p.baseY; p.cooldown = 0; });
        state.eventText = "코너킥"; state.possessionTeam = sideTeam === 1 ? 2 : 1;
        let attTeam = state.possessionTeam;
        let goalX = sideTeam === 1 ? 2 : 98; state.ball.x = goalX; state.ball.y = (state.ball.y > 50) ? 98 : 2;
        
        state.players.forEach(p => { 
            if(p.role !== 'GK') { 
                if (p.team === attTeam) { p.x = goalX + (sideTeam === 1 ? 1 : -1) * (5 + Math.random()*10); p.y = 35 + Math.random() * 30; }
                else { p.x = goalX + (sideTeam === 1 ? 1 : -1) * 3; p.y = 35 + Math.random() * 30; }
            } 
        });
        let kicker = state.players.find(p => p.team === attTeam && p.role === 'FW');
        if(kicker) { kicker.x = state.ball.x; kicker.y = state.ball.y; kicker.cooldown = 15; }
    }
    else if (type === 'goal_kick') {
        state.eventText = "골킥"; state.possessionTeam = sideTeam;
        let goalX = sideTeam === 1 ? 5 : 95; state.ball.x = goalX; state.ball.y = 50;
        
        state.players.forEach(p => {
            if (p.team === sideTeam) {
                if(p.role === 'DF') { p.x = goalX + (dir*15); p.y = p.baseY; } 
                else if(p.role === 'MF') { p.x = 50 - (dir*10); p.y = p.baseY; } 
                else if(p.role === 'FW') { p.x = 50 + (dir*15); p.y = p.baseY; }
            } else { p.x = 50 + (dir*15); p.y = p.baseY; }
        });
        let gk = state.players.find(p => p.team === sideTeam && p.role === 'GK');
        if(gk) { gk.x = state.ball.x; gk.y = state.ball.y; gk.cooldown = 0; } 
        state.ball.vx = 0; state.ball.vy = 0;
    }
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
    setTimeout(() => { startMatchPhase(roomCode, true); }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
