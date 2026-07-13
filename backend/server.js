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

// --- 헬퍼 함수 (안전성 철통 방어) ---
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
    state.passTargetId = null; // ★ 패스 타겟 (마중 나오기용)
    state.players.forEach(p => { p.x = p.baseX; p.y = p.baseY; p.cooldown = 0; });
    const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW') || state.players.find(p => p.team === kickoffTeam);
    if (striker) { striker.x = 50; striker.y = kickoffTeam === 1 ? 52 : 48; }
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
        if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length < 2) {
            rooms[roomCode].players[socket.id] = { id: 'player2', ready: false, team: [] };
            socket.join(roomCode); socket.emit('roomJoined', roomCode, db); io.to(roomCode).emit('playerJoinedLobby'); 
        } else { socket.emit('error', '방이 가득 찼거나 존재하지 않는 코드입니다.'); }
    });
    socket.on('setTimer', (roomCode, timerValue) => { if (rooms[roomCode]) { rooms[roomCode].settings.timer = timerValue; socket.to(roomCode).emit('timerUpdated', timerValue); } });
    socket.on('playerReady', (roomCode, formationId) => {
        const room = rooms[roomCode]; if(!room || !room.players[socket.id]) return; 
        room.players[socket.id].formation = formationId; room.players[socket.id].ready = true;
        const playersArr = Object.values(room.players);
        if (playersArr.every(p => p.ready) && playersArr.length === 2) startDraftPhase(roomCode);
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
            phase: 'play', setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이", isPaused: false, throwerId: null, gkHolder: null, offsidePos: null, offsideTeam: null, passTargetId: null,
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
    }

    resetPositions(room.matchState, isSecondHalf ? 2 : 1);  
    io.to(roomCode).emit('matchStarted', room.matchState); io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        if (state.isPaused) return; 
        state.ticks++;

        // ★ [핵심 1] 모든 객체의 NaN 무결성 방어 (게임 멈춤 원천 차단)
        if (isNaN(state.ball.x) || isNaN(state.ball.y)) { state.ball.x = 50; state.ball.y = 50; state.ball.vx = 0; state.ball.vy = 0; }
        state.players.forEach(p => {
            if (isNaN(p.x) || isNaN(p.y)) { p.x = p.baseX; p.y = p.baseY; }
            if (isNaN(p.cooldown)) p.cooldown = 0;
        });

        // --- 1. 세트피스 로직 ---
        if (state.phase !== 'play') {
            if (state.phase === 'gk_hold' && state.gkHolder) {
                state.ball.x = state.gkHolder.x + (state.gkHolder.team === 1 ? 1.5 : -1.5); 
                state.ball.y = state.gkHolder.y; state.ball.vx = 0; state.ball.vy = 0;
            }
            
            if (state.phase === 'offside_pending') {
                state.setPieceTimer--;
                state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
                state.ball.vx *= 0.82; state.ball.vy *= 0.82; 
                if (state.setPieceTimer <= 0) {
                    io.to(roomCode).emit('playSound', 'whistle');
                    setupSetPiece(state, 'offside', state.offsideTeam === 1 ? 2 : 1);
                }
                emitUpdate(roomCode, state);
                return;
            }

            state.setPieceTimer--;
            if (state.setPieceTimer <= 0) {
                io.to(roomCode).emit('playSound', 'kick');
                
                if (state.phase === 'gk_hold' && state.gkHolder) {
                    let p = state.gkHolder;
                    let bestMate = null; let maxScore = -999;
                    
                    state.players.forEach(m => {
                        if (m.team === p.team && m.role !== 'GK') {
                            let minEnemyDist = Infinity;
                            state.players.forEach(e => { if (e.team !== p.team) { let d = getDistance(m.x, m.y, e.x, e.y); if(d < minEnemyDist) minEnemyDist = d; } });
                            let dFromGk = getDistance(p.x, p.y, m.x, m.y);
                            let score = (minEnemyDist * 20) - dFromGk; 
                            if (m.role === 'DF' && Math.abs(m.y - 50) > 20) score += 50; 
                            if (score > maxScore && minEnemyDist > 15) { maxScore = score; bestMate = m; }
                        }
                    });

                    if (!bestMate) {
                        let mates = state.players.filter(m => m.team === p.team && m.role !== 'GK');
                        bestMate = mates.sort((a,b) => (p.team===1?b.x-a.x:a.x-b.x))[0];
                    }

                    if (bestMate) {
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y) || 1;
                        let passPower = 6.0; 
                        state.ball.vx = ((bestMate.x - p.x) / d) * passPower; 
                        state.ball.vy = ((bestMate.y - p.y) / d) * passPower;
                        state.passTargetId = bestMate.id; // ★ 키퍼 패스 시에도 마중 나감
                    } else {
                        let dir = (p.team === 1) ? 1 : -1;
                        state.ball.vx = dir * 7.5; state.ball.vy = (p.y > 50) ? 3.5 : -3.5;
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
                        } else { state.ball.vx = dir * 2.5; state.ball.vy = 0; }
                    } else if (state.phase === 'offside') {
                        let mates = state.players.filter(p => p.team === state.possessionTeam && p.id !== state.throwerId && p.role !== 'GK');
                        mates.sort((a,b) => getDistance(state.ball.x, state.ball.y, a.x, a.y) - getDistance(state.ball.x, state.ball.y, b.x, b.y));
                        let target = mates.find(m => (state.possessionTeam === 1 ? m.x > state.ball.x : m.x < state.ball.x)) || mates[0];
                        if(target) {
                            let dist = getDistance(state.ball.x, state.ball.y, target.x, target.y) || 1;
                            state.ball.vx = ((target.x - state.ball.x) / dist) * 4.5; state.ball.vy = ((target.y - state.ball.y) / dist) * 4.5;
                            state.passTargetId = target.id;
                        } else { state.ball.vx = dir * 3.0; state.ball.vy = 0; }
                    } else if (state.phase === 'corner') {
                        let targetX = (state.possessionTeam === 1) ? 90 : 10;
                        let targetY = 50 + (Math.random() - 0.5) * 15;
                        let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                        state.ball.vx = ((targetX - state.ball.x) / dist) * 3.5; state.ball.vy = ((targetY - state.ball.y) / dist) * 3.5;
                    } else if (state.phase === 'goal_kick') {
                        state.ball.vx = 0; state.ball.vy = 0;
                    }
                }
                state.phase = 'play'; state.eventText = "오픈 플레이"; state.gkHolder = null;
            }
            if (state.phase !== 'play' && state.phase !== 'gk_hold') { emitUpdate(roomCode, state); return; }
        }

        // --- 2. 물리 연산 ---
        if (state.phase === 'play') {
            state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
            state.ball.vx *= 0.82; state.ball.vy *= 0.82; 
            
            if (state.ball.y <= 0 || state.ball.y >= 100) { setupSetPiece(state, 'throw_in'); return; }
            if (state.ball.x <= 0) {
                if (state.ball.y >= 38 && state.ball.y <= 62) { handleGoal(room, 2); return; } 
                else { setupSetPiece(state, state.lastTouchTeam === 1 ? 'corner' : 'goal_kick', 1); return; }
            } else if (state.ball.x >= 100) {
                if (state.ball.y >= 38 && state.ball.y <= 62) { handleGoal(room, 1); return; }
                else { setupSetPiece(state, state.lastTouchTeam === 2 ? 'corner' : 'goal_kick', 2); return; }
            }
        }

        // --- 3. 오프사이드 라인 및 소유권 계산 ---
        let t2Defenders = [...state.players].filter(p => p.team === 2).sort((a,b) => b.x - a.x); 
        let offsideLine1 = Math.max(50, state.ball.x); 
        if (t2Defenders.length > 1) offsideLine1 = Math.max(offsideLine1, t2Defenders[1].x);

        let t1Defenders = [...state.players].filter(p => p.team === 1).sort((a,b) => a.x - b.x); 
        let offsideLine2 = Math.min(50, state.ball.x);
        if (t1Defenders.length > 1) offsideLine2 = Math.min(offsideLine2, t1Defenders[1].x);

        let distArr1 = [], distArr2 = [];
        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            let strayDist = getDistance(p.x, p.y, p.baseX, p.baseY) || 0;
            let pressScore = dist;
            
            if(p.role !== 'GK') { 
                if (p.team === 1) distArr1.push({p, dist, pressScore, strayDist}); 
                else distArr2.push({p, dist, pressScore, strayDist}); 
            }
        });
        
        let minDist1 = distArr1.length > 0 ? Math.min(...distArr1.map(o => o.dist)) : Infinity;
        let minDist2 = distArr2.length > 0 ? Math.min(...distArr2.map(o => o.dist)) : Infinity;

        if(minDist1 < minDist2 && minDist1 < 10) state.possessionTeam = 1;
        else if(minDist2 <= minDist1 && minDist2 < 10) state.possessionTeam = 2;
        const attTeam = state.possessionTeam;

        distArr1.sort((a,b) => a.pressScore - b.pressScore); 
        distArr2.sort((a,b) => a.pressScore - b.pressScore);

        let ballCarrier = state.players.find(b => b.team === attTeam && getDistance(b.x, b.y, state.ball.x, state.ball.y) < 6);

        // --- 4. 움직임 AI (수비, 지원, 침투, 마중) ---
        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let ownGoalX = (p.team === 1) ? 0 : 100;
            
            let myDistArr = (p.team === 1) ? distArr1 : distArr2;
            let rankObj = myDistArr.find(obj => obj.p === p);
            let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
            let distToBall = rankObj ? rankObj.dist : 999;
            let strayDist = rankObj ? rankObj.strayDist : 0;
            let isFinalThirdDef = getDistance(state.ball.x, state.ball.y, ownGoalX, 50) < 35;

            let isPressing = false;
            
            if (state.isKickoff) {
                let isStriker = (p.team === state.kickoffTeam) && (p.x === 50) && (p.y === 52 || p.y === 48);
                if (isStriker) { targetX = 50; targetY = 50; isPressing = true; } 
                else { targetX = p.baseX; targetY = p.baseY; }
            } 
            else {
                // ★ [핵심 2] 완벽한 마중 나오기 (Active Receiving)
                if (state.passTargetId === p.id) {
                    targetX = state.ball.x; 
                    targetY = state.ball.y; 
                    isPressing = true; // 공을 향해 전력 질주
                }
                // 압박 로직 (공격수는 전방에서만, 미드/수비는 자기 자리 근처에서만)
                else if (p.role !== 'GK' && attTeam !== p.team) {
                    if (p.role === 'FW') {
                        if (distToBall < 20 && rank === 0) isPressing = true;
                    } else {
                        let maxStray = (p.role === 'DF') ? 15 : 20; 
                        if (rank === 0 && strayDist < maxStray) isPressing = true;
                        else if (rank === 1 && isFinalThirdDef && distToBall < 10) isPressing = true;
                    }
                }

                if (p.role === 'GK') {
                    targetX = ownGoalX + (dir * 2); targetY = Math.max(42, Math.min(58, state.ball.y)); 
                    if(distToBall < 10) { targetX = state.ball.x; targetY = state.ball.y; }
                } 
                else if (isPressing) { 
                    targetX = state.ball.x; targetY = state.ball.y; 
                } 
                else if (attTeam === p.team) {
                    let attackVariant = Math.sin(state.ticks / 30 + p.baseY); 
                    
                    if (ballCarrier && p.id === ballCarrier.id) {
                        targetX = state.ball.x + (dir * 2); targetY = state.ball.y;
                    }
                    else if (ballCarrier && p.id !== ballCarrier.id && !state.passTargetId) {
                        let distToCarrier = getDistance(p.x, p.y, ballCarrier.x, ballCarrier.y);
                        
                        if (p.role === 'FW') { 
                            let offLine = (p.team === 1) ? offsideLine1 : offsideLine2;
                            targetX = offLine - (dir * 1.5);
                            if (distToCarrier < 40) targetX += (dir * 8); 
                            targetY = p.baseY; 
                        } 
                        else if (p.role === 'MF') { 
                            targetX = Math.max(25, Math.min(75, ballCarrier.x + (dir * 10))); 
                            targetY = p.baseY;
                            if (distToCarrier < 18) { targetY = ballCarrier.y + (p.baseY > 50 ? 15 : -15); }
                        } 
                        else if (p.role === 'DF') { 
                            targetX = Math.max(20, Math.min(80, state.ball.x - (dir * 15))); targetY = p.baseY; 
                        }

                        let spaceShift = 0;
                        state.players.forEach(e => {
                            if (e.team !== p.team && e.role !== 'GK') {
                                let dToTarget = getDistance(targetX, targetY, e.x, e.y);
                                if (dToTarget < 12) { spaceShift += (targetY > e.y) ? 6 : -6; }
                            }
                        });
                        targetY += spaceShift;
                    } 
                    else {
                        if (p.role === 'DF') { targetX = Math.max(25, Math.min(75, state.ball.x - (dir * 18))); targetY = p.baseY + attackVariant * 5; } 
                        else if (p.role === 'MF') { targetX = Math.max(35, Math.min(65, state.ball.x + (dir * 12))); targetY = p.baseY + attackVariant * 10; } 
                        else if (p.role === 'FW') { targetX = (p.team === 1) ? 88 : 12; targetY = p.baseY + attackVariant * 10; }
                    }
                } 
                else {
                    if (p.role === 'DF') { 
                        if (isFinalThirdDef) { targetX = ownGoalX + (dir * 15); targetY = p.baseY * 0.4 + 50 * 0.6; } 
                        else { targetX = Math.max(15, Math.min(85, state.ball.x - (dir * 20))); targetY = p.baseY; }
                    } 
                    else if (p.role === 'MF') { 
                        if (isFinalThirdDef) { targetX = ownGoalX + (dir * 25); targetY = p.baseY * 0.5 + 50 * 0.5; } 
                        else { targetX = state.ball.x - (dir * 10); targetY = p.baseY; }
                    } 
                    else if (p.role === 'FW') { targetX = state.ball.x + (dir * 12); targetY = p.baseY; }
                }
            }

            // ★ 겹침 방지 밀어내기 (적군끼리는 더 강하게 튕겨냄)
            state.players.forEach(other => {
                if (other !== p && other.role !== 'GK') {
                    let d = getDistance(p.x, p.y, other.x, other.y) || 1;
                    if (d < 4) { 
                        let force = (other.team === p.team) ? 1.0 : 1.5; // 적군일 때 밀어내기 1.5배 강화
                        if (isPressing || state.passTargetId === p.id) force = 0.3; // 직진하는 선수는 밀림 최소화
                        targetX += ((p.x - other.x) / d) * force * 4; 
                        targetY += ((p.y - other.y) / d) * force * 4; 
                    }
                }
            });

            targetX = isNaN(targetX) ? p.baseX : Math.max(5, Math.min(95, targetX)); 
            targetY = isNaN(targetY) ? p.baseY : Math.max(5, Math.min(95, targetY));
            
            let moveSpeed = ((p.stats && p.stats.spd ? p.stats.spd : 80) / 100); 
            if (isPressing || state.passTargetId === p.id) moveSpeed *= 1.35; 
            else moveSpeed *= (0.85 + Math.random() * 0.3);
            
            let distToTarget = getDistance(p.x, p.y, targetX, targetY) || 1;
            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 5. 터치 및 패스/슛 스마트 판단 ---
            let touchRadius = p.role === 'GK' ? 3.0 : 2.5; // 터치 반경 안정화
            let distToBallAct = getDistance(p.x, p.y, state.ball.x, state.ball.y);

            if (distToBallAct < touchRadius && p.cooldown === 0 && state.phase === 'play') { 
                state.lastTouchTeam = p.team;
                state.passTargetId = null; // 공을 만지면 패스 타겟 초기화

                let targetGoalX = (p.team === 1) ? 100 : 0;
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                let enemyAhead = false;
                let enemiesNear = 0;
                state.players.forEach(e => {
                    if (e.team !== p.team && e.role !== 'GK') {
                        let d = getDistance(p.x, p.y, e.x, e.y);
                        if (d < 15) enemiesNear++;
                        if (d < 11 && ((p.team === 1 && e.x > p.x) || (p.team === 2 && e.x < p.x))) { enemyAhead = true; }
                    }
                });
                let isHeavyPressure = (enemiesNear >= 2);

                if (state.isKickoff) {
                    if (p.team === state.kickoffTeam) {
                        let teammates = state.players.filter(m => m.team === p.team && m.role !== 'GK' && m.id !== p.id && getDistance(m.x, m.y, state.ball.x, state.ball.y) > 3);
                        let behind = teammates.filter(m => (p.team === 1 ? m.x < state.ball.x - 2 : m.x > state.ball.x + 2));
                        let targetMate = behind.length > 0 ? behind[Math.floor(Math.random() * behind.length)] : teammates[0];
                        if (targetMate) {
                            let d = getDistance(p.x, p.y, targetMate.x, targetMate.y) || 1;
                            let passPower = 2.6;
                            state.ball.vx = ((targetMate.x - p.x) / d) * passPower; state.ball.vy = ((targetMate.y - p.y) / d) * passPower;
                            state.passTargetId = targetMate.id;
                            io.to(roomCode).emit('playSound', 'kick'); p.cooldown = 12; state.isKickoff = false; return; 
                        }
                    }
                    state.isKickoff = false; 
                }

                if (p.role === 'GK') {
                    let isInBox = Math.abs(p.x - ownGoalX) < 20 && p.y > 20 && p.y < 80;
                    if (isInBox) {
                        state.phase = 'gk_hold'; state.gkHolder = p; state.setPieceTimer = 15;
                        state.ball.vx = 0; state.ball.vy = 0; state.ball.x = p.x; state.ball.y = p.y;
                        state.eventText = "키퍼 선방!"; p.cooldown = 20;
                    } else {
                        io.to(roomCode).emit('playSound', 'kick');
                        state.ball.vx = dir * 6.0; state.ball.vy = (p.y > 50) ? 3.0 : -3.0; p.cooldown = 15;
                    }
                } 
                else if (distToGoal < 30) {
                    let angleFactor = 1 - Math.min(1, Math.abs(p.y - 50) / 20);
                    let spaceFactor = enemyAhead ? 0.3 : 1.0;
                    let shootProb = Math.min(0.92, 0.48 + angleFactor * 0.35 + spaceFactor * 0.22);
                    
                    if (Math.random() < shootProb && (!enemyAhead || Math.random() < 0.55)) {
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = ((p.stats && p.stats.sht ? p.stats.sht : 85) / 11.6) * (0.90 + Math.random() * 0.25);  
                        let aimSpread = 11 + Math.random() * 11;
                        let aimY = 50 + (Math.random() - 0.5) * aimSpread * 0.95;
                        aimY = Math.max(38, Math.min(62, aimY));
                        let dx = targetGoalX - p.x, dy = aimY - p.y;
                        let d = Math.sqrt(dx*dx + dy*dy) || 1; 
                        state.ball.vx = (dx / d) * power * (0.92 + Math.random()*0.14); state.ball.vy = (dy / d) * power * (0.90 + Math.random()*0.18) + (Math.random()-0.5)*0.42;
                        p.cooldown = 8 + Math.floor(Math.random()*5);
                    } else { executePassOrDribble(); }
                } 
                else { executePassOrDribble(); }

                function executePassOrDribble() {
                    let isFinalThirdAtt = (p.team === 1 && p.x > 66) || (p.team === 2 && p.x < 34);
                    let isWinger = p.y < 25 || p.y > 75;

                    if (isFinalThirdAtt && isWinger && Math.random() < 0.65) {
                        let strikersInBox = state.players.filter(m => m.team === p.team && m !== p && Math.abs(m.y - 50) < 30 && m.role !== 'DF');
                        if (strikersInBox.length > 0) {
                            let target = strikersInBox[Math.floor(Math.random() * strikersInBox.length)];
                            io.to(roomCode).emit('playSound', 'kick');
                            let power = ((p.stats && p.stats.pas ? p.stats.pas : 80) / 22);   
                            let targetX = target.x + dir * 5; 
                            let d = getDistance(p.x, p.y, targetX, target.y) || 1;
                            state.ball.vx = ((targetX - p.x) / d) * power;
                            state.ball.vy = ((target.y - p.y) / d) * power;
                            state.passTargetId = target.id;
                            p.cooldown = 10; 
                            return; 
                        }
                    }

                    let bestMate = null; let maxScore = -999;
                    state.players.forEach(m => {
                        if (m.team === p.team && m !== p && m.role !== 'GK') {
                            let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x); 
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            
                            // ★ 빌드업 전진 패스 선호도 2배 상향
                            let score = (forwardDist * 8) - dist + ((Math.random() * 30) - 5); 
                            if (forwardDist < 0) score -= 50; // 백패스 페널티
                            
                            let laneBlocked = false;
                            let minEnemyDistToM = Infinity;
                            state.players.forEach(e => {
                                if (e.team !== p.team) {
                                    if (pDistance(e.x, e.y, p.x, p.y, m.x, m.y) < 1.5) laneBlocked = true;
                                    let d2 = getDistance(m.x, m.y, e.x, e.y);
                                    if (d2 < minEnemyDistToM) minEnemyDistToM = d2;
                                }
                            });
                            
                            let isOffside = false;
                            if (p.team === 1 && m.x > offsideLine1) isOffside = true;
                            if (p.team === 2 && m.x < offsideLine2) isOffside = true;

                            if (laneBlocked) score -= 800; 
                            if (isOffside) score -= 800;   // ★ 오프사이드 철저히 방지
                            if (dist < 4 || dist > 85) score -= 100; 
                            
                            score += minEnemyDistToM * 2; 
                            if (enemyAhead && forwardDist < 5 && dist < 30) score += 100; // 앞막히면 강력히 백패스/횡패스

                            if (isHeavyPressure) {
                                if (Math.abs(m.y - p.y) > 30 && minEnemyDistToM > 8) score += 300; 
                                if (forwardDist > 25 && minEnemyDistToM > 10) score += 200; 
                            }

                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    if ((enemyAhead || isHeavyPressure || maxScore > -100) && bestMate) {
                        let receiverIsOffside = false;
                        if (p.team === 1 && bestMate.x > offsideLine1) receiverIsOffside = true;
                        if (p.team === 2 && bestMate.x < offsideLine2) receiverIsOffside = true;

                        if (receiverIsOffside) {
                            state.phase = 'offside_pending'; state.setPieceTimer = 5; // 오프사이드 휘슬 즉각 반응
                            state.offsidePos = { x: bestMate.x, y: bestMate.y }; state.offsideTeam = p.team;
                            state.eventText = "오프사이드 반칙!";
                        }

                        let isThroughPass = false;
                        let isLongBall = getDistance(p.x, p.y, bestMate.x, bestMate.y) > 30;
                        let targetX = bestMate.x; let targetY = bestMate.y;
                        let spaceBehind = (p.team === 1) ? (offsideLine1 - bestMate.x) : (bestMate.x - offsideLine2);

                        if (spaceBehind > 10 && Math.random() < 0.7 && bestMate.role !== 'DF') {
                            isThroughPass = true;
                            targetX += dir * Math.min(spaceBehind * 0.8, 15); 
                        } else if (isLongBall) {
                            targetX += dir * 5; 
                        }

                        io.to(roomCode).emit('playSound', 'kick');
                        // 패스 속도 강화
                        let power = ((p.stats && p.stats.pas ? p.stats.pas : 80) / 25); 
                        if (isThroughPass || isLongBall) power *= 1.35; 

                        let d = getDistance(p.x, p.y, targetX, targetY) || 1; 
                        state.ball.vx = ((targetX - p.x) / d) * power;
                        state.ball.vy = ((targetY - p.y) / d) * power; 
                        p.cooldown = 10; 
                        
                        // ★ [핵심 3] 마중 & 수비 스턴
                        state.passTargetId = bestMate.id; // 동료는 즉시 공으로 뛰어옴
                        state.players.forEach(op => {
                            if (op.team !== p.team && getDistance(op.x, op.y, p.x, p.y) < 15) {
                                op.cooldown = 5; // 패스 순간 수비수 0.5초간 얼음 (턴오버 방지)
                            }
                        });
                    } 
                    else {
                        let currentVySign = state.ball.vy >= 0 ? 1 : -1;
                        let dodgeY = currentVySign * 1.5; 
                        if (Math.abs(state.ball.vy) < 0.2) dodgeY = (p.y > 50) ? -1.5 : 1.5;

                        if (enemyAhead) { 
                            state.ball.vx = dir * 0.8; state.ball.vy = dodgeY * 1.2; 
                        } else { 
                            state.ball.vx = dir * 1.7; state.ball.vy = dodgeY * 0.2; 
                        }
                        p.cooldown = 3; 
                    }
                }
            }
        });

        emitUpdate(roomCode, state);

        if ((state.ticks / 10) >= db.settings.halfDurationRealSeconds) {
            clearInterval(room.matchInterval);
            io.to(roomCode).emit('playSound', 'whistle'); 
            if (state.half === 1) startHalfTime(roomCode);
            else io.to(roomCode).emit('matchEnded', state.score); 
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
        let thrower = fieldPlayers.reduce((prev, curr) => (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev));
        
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
    else if (type === 'offside') {
        // ★ [핵심 4] 오프사이드 진형 및 프리킥 정상화
        state.eventText = "오프사이드 반칙!";
        state.possessionTeam = sideTeam; // 프리킥을 차는 팀 (수비하던 팀)
        state.ball.x = Math.max(5, Math.min(95, state.offsidePos.x)); 
        state.ball.y = Math.max(5, Math.min(95, state.offsidePos.y));
        
        state.players.forEach(p => {
            p.cooldown = 0;
            if (p.role !== 'GK') {
                if (p.team === sideTeam) {
                    // 프리킥 차는 팀은 공 주변에서 입체적 대형 유지
                    p.x = state.ball.x + (dir * -5);
                    p.y = p.baseY;
                } else {
                    // 반칙 범한 팀은 자기 진영으로 크게 물러나서 수비 대형 복구
                    p.x = state.ball.x + (dir * 25);
                    p.y = p.baseY;
                }
                p.x = Math.max(10, Math.min(90, p.x));
            }
        });
        
        // 프리킥 키커 설정
        let fieldPlayers = state.players.filter(p => p.team === sideTeam && p.role !== 'GK');
        let kicker = fieldPlayers.reduce((prev, curr) => (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev), fieldPlayers[0]);
        if(kicker) { kicker.x = state.ball.x; kicker.y = state.ball.y; kicker.cooldown = 15; state.throwerId = kicker.id; }
    }
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
    setTimeout(() => { startMatchPhase(roomCode, true); }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
