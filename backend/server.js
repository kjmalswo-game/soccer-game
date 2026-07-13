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
function getDistance(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); }

// ★ 패스 차단을 위한 수학 공식 (점과 선분 사이의 최단 거리 구하기)
function pDistance(x, y, x1, y1, x2, y2) {
    let A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
    let dot = A * C + B * D;
    let len_sq = C * C + D * D;
    let param = -1;
    if (len_sq !== 0) param = dot / len_sq;
    let xx, yy;
    if (param < 0) { xx = x1; yy = y1; } 
    else if (param > 1) { xx = x2; yy = y2; } 
    else { xx = x1 + param * C; yy = y1 + param * D; }
    let dx = x - xx, dy = y - yy;
    return Math.sqrt(dx * dx + dy * dy);
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
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode, db);
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
            phase: 'play', setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이", isPaused: false, throwerId: null, gkHolder: null, offsidePos: null, offsideTeam: null,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => { return { ...t.player, team: 1, role: getRole(p1Formation[t.slot].id), posId: p1Formation[t.slot].id, x: p1Formation[t.slot].x / 2, y: p1Formation[t.slot].y, baseX: p1Formation[t.slot].x / 2, baseY: p1Formation[t.slot].y, cooldown: 0 }; }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats, cooldown: 0 },
                ...p2Data.team.map((t, idx) => { return { ...t.player, team: 2, role: getRole(p2Formation[t.slot].id), posId: p2Formation[t.slot].id, x: 100 - (p2Formation[t.slot].x / 2), y: 100 - p2Formation[t.slot].y, baseX: 100 - (p2Formation[t.slot].x / 2), baseY: 100 - p2Formation[t.slot].y, cooldown: 0 }; }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', posId:'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats, cooldown: 0 }
            ]
        };
    } else {
        room.matchState.half = 2; room.matchState.ticks = 0; room.matchState.phase = 'play'; room.matchState.isPaused = false;
    }

    resetPositions(room.matchState, isSecondHalf ? 2 : 1);  
    io.to(roomCode).emit('matchStarted', room.matchState); io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        if (state.isPaused) return; 
        state.ticks++;

        // --- ★ 1. 오프사이드 및 세트피스 로직 ---
        if (state.phase !== 'play') {
            if (state.phase === 'gk_hold' && state.gkHolder) {
                state.ball.x = state.gkHolder.x + (state.gkHolder.team === 1 ? 1.5 : -1.5); 
                state.ball.y = state.gkHolder.y; state.ball.vx = 0; state.ball.vy = 0;
            }
            
            // 오프사이드 휘슬 대기 시간 (약 1초)
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
                            let score = (minEnemyDist * 5) - dFromGk;
                            let isForward = (p.team === 1 && m.x > p.x) || (p.team === 2 && m.x < p.x);
                            if (isForward) score += 30;
                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    if (bestMate) {
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y) || 1;
                        state.ball.vx = ((bestMate.x - p.x) / d) * 5.5; state.ball.vy = ((bestMate.y - p.y) / d) * 5.5;
                    } else {
                        let dir = (p.team === 1) ? 1 : -1;
                        state.ball.vx = dir * 6.5; state.ball.vy = (p.y > 50) ? 3.5 : -3.5;
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
                        } else { state.ball.vx = dir * 2.5; state.ball.vy = 0; }
                    } else if (state.phase === 'corner' || state.phase === 'offside') {
                        // 오프사이드 간접프리킥 & 코너킥
                        let targetX = (state.possessionTeam === 1) ? 90 : 10;
                        if (state.phase === 'offside') targetX = state.ball.x + (dir * 20); // 오프사이드 프리킥은 전방으로
                        let targetY = 50 + (Math.random() - 0.5) * 15;
                        let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                        state.ball.vx = ((targetX - state.ball.x) / dist) * 3.5; state.ball.vy = ((targetY - state.ball.y) / dist) * 3.5;
                    } else if (state.phase === 'goal_kick') {
                        state.ball.vx = dir * 5.5; state.ball.vy = (Math.random() - 0.5) * 3;
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

        // --- 3. 오프사이드 라인 실시간 계산 (가장 뒤에서 두 번째 수비수) ---
        let t2Defenders = [...state.players].filter(p => p.team === 2).sort((a,b) => b.x - a.x); // 팀2 (우측 방어)
        let offsideLine1 = Math.max(50, state.ball.x); // 하프라인과 공 위치 중 앞선 곳이 최소 기준
        if (t2Defenders.length > 1) offsideLine1 = Math.max(offsideLine1, t2Defenders[1].x); // 2번째 수비수 위치

        let t1Defenders = [...state.players].filter(p => p.team === 1).sort((a,b) => a.x - b.x); // 팀1 (좌측 방어)
        let offsideLine2 = Math.min(50, state.ball.x);
        if (t1Defenders.length > 1) offsideLine2 = Math.min(offsideLine2, t1Defenders[1].x);

        // 소유권 계산
        let distArr1 = [], distArr2 = [];
        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if(p.role !== 'GK') { if (p.team === 1) distArr1.push({p, dist}); else distArr2.push({p, dist}); }
        });
        distArr1.sort((a,b) => a.dist - b.dist); distArr2.sort((a,b) => a.dist - b.dist);
        let minDist1 = distArr1[0] ? distArr1[0].dist : Infinity;
        let minDist2 = distArr2[0] ? distArr2[0].dist : Infinity;
        if(minDist1 < minDist2 && minDist1 < 10) state.possessionTeam = 1;
        else if(minDist2 <= minDist1 && minDist2 < 10) state.possessionTeam = 2;
        const attTeam = state.possessionTeam;

        // --- 4. 변칙적 오프더볼 및 수비 AI ---
        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let ownGoalX = (p.team === 1) ? 0 : 100;
            
            let myDistArr = (p.team === 1) ? distArr1 : distArr2;
            let rankObj = myDistArr.find(obj => obj.p === p);
            let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
            let distToBall = rankObj ? rankObj.dist : 999;
            let isFinalThirdDef = getDistance(state.ball.x, state.ball.y, ownGoalX, 50) < 35;

            let isPressing = false;
            if (state.isKickoff) {
                let isStriker = (p.team === state.kickoffTeam) && (p.x === 50) && (p.y === 52 || p.y === 48);
                if (isStriker) { targetX = 50; targetY = 50; isPressing = true; } 
                else { targetX = p.baseX; targetY = p.baseY; isPressing = false; }
            } 
            else {
                if (p.role !== 'GK') {
                    if (rank === 0) isPressing = true;
                    else if (rank === 1 && isFinalThirdDef && distToBall < 15) isPressing = true;
                    else if (rank === 1 && distToBall < 8) isPressing = true;
                }

                if (p.role === 'GK') {
                    targetX = ownGoalX + (dir * 2); targetY = Math.max(42, Math.min(58, state.ball.y)); 
                    if(distToBall < 10) { targetX = state.ball.x; targetY = state.ball.y; }
                } 
                else if (isPressing) { targetX = state.ball.x; targetY = state.ball.y; } 
                else if (attTeam === p.team) {
                    let attackVariant = Math.sin(state.ticks / 30 + p.baseY); 
                    if (p.role === 'DF') { targetX = Math.max(25, Math.min(75, state.ball.x - (dir * 18))); targetY = p.baseY + attackVariant * 5; } 
                    else if (p.role === 'MF') { targetX = Math.max(35, Math.min(65, state.ball.x + (dir * 12))); targetY = p.baseY + attackVariant * 15; } 
                    else if (p.role === 'FW') { 
                        targetX = (p.team === 1) ? 88 + attackVariant * 5 : 12 - attackVariant * 5; targetY = p.baseY + attackVariant * 15; 
                    }
                    
                    // ★ 오프사이드 트랩을 피하기 위한 공격수 라인 컨트롤 (살짝만 안쪽에 위치)
                    if (p.team === 1) targetX = Math.min(targetX, offsideLine1 - 0.5 + (Math.random() > 0.9 ? 3 : 0)); // 가끔 실수로 넘음
                    if (p.team === 2) targetX = Math.max(targetX, offsideLine2 + 0.5 - (Math.random() > 0.9 ? 3 : 0));
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

            state.players.forEach(mate => {
                if (mate !== p && mate.team === p.team && mate.role !== 'GK') {
                    if (getDistance(p.x, p.y, mate.x, mate.y) < 12) { targetX += (p.x - mate.x) * 1.5; targetY += (p.y - mate.y) * 1.5; }
                }
            });

            targetX = Math.max(3, Math.min(97, targetX)); targetY = Math.max(3, Math.min(97, targetY));
            let moveSpeed = ((p.stats && p.stats.spd ? p.stats.spd : 80) / 100) * (0.85 + Math.random() * 0.3); 
            if (isPressing) moveSpeed *= 1.3; 
            
            let distToTarget = getDistance(p.x, p.y, targetX, targetY) || 1;
            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 5. 터치 및 패스/슛 스마트 판단 ---
            let touchRadius = p.role === 'GK' ? 2.7 : 3;   
            let distToBallAct = getDistance(p.x, p.y, state.ball.x, state.ball.y);

            if (distToBallAct < touchRadius && p.cooldown === 0 && state.phase === 'play') { 
                state.lastTouchTeam = p.team;
                let targetGoalX = (p.team === 1) ? 100 : 0;
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                let enemyAhead = false;
                state.players.forEach(e => {
                    if (e.team !== p.team && e.role !== 'GK') {
                        let d = getDistance(p.x, p.y, e.x, e.y);
                        if (d < 11 && ((p.team === 1 && e.x > p.x) || (p.team === 2 && e.x < p.x))) { enemyAhead = true; }
                    }
                });

                if (state.isKickoff) {
                    if (p.team === state.kickoffTeam) {
                        let teammates = state.players.filter(m => m.team === p.team && m.role !== 'GK' && m.id !== p.id && getDistance(m.x, m.y, state.ball.x, state.ball.y) > 3);
                        let behind = teammates.filter(m => (p.team === 1 ? m.x < state.ball.x - 2 : m.x > state.ball.x + 2));
                        let targetMate = behind.length > 0 ? behind[Math.floor(Math.random() * behind.length)] : teammates[0];
                        if (targetMate) {
                            let d = getDistance(p.x, p.y, targetMate.x, targetMate.y) || 1;
                            let passPower = 2.6;
                            state.ball.vx = ((targetMate.x - p.x) / d) * passPower; state.ball.vy = ((targetMate.y - p.y) / d) * passPower;
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
                    let bestMate = null; let maxScore = -999;
                    state.players.forEach(m => {
                        if (m.team === p.team && m !== p && m.role !== 'GK') {
                            let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x); 
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            let score = (forwardDist * 4) - dist + ((Math.random() * 38) - 9); 
                            
                            // ★ 패스 차단 로직 (상대 선수가 패스 궤도에 서 있는지 확인)
                            let laneBlocked = false;
                            state.players.forEach(e => {
                                if (e.team !== p.team) {
                                    // p와 m 사이의 선분과 적(e) 사이의 거리가 3.5 이하이면 패스길이 막힌 것으로 간주
                                    if (pDistance(e.x, e.y, p.x, p.y, m.x, m.y) < 3.5) laneBlocked = true;
                                }
                            });
                            
                            // ★ 오프사이드 체크 로직 (받을 선수가 오프사이드 라인을 넘었는지 확인)
                            let isOffside = false;
                            if (p.team === 1 && m.x > offsideLine1) isOffside = true;
                            if (p.team === 2 && m.x < offsideLine2) isOffside = true;

                            if (laneBlocked) score -= 800; // 패스길이 막혔으면 절대 주지 않음
                            if (isOffside) score -= 150;   // 오프사이드면 패스 확률 대폭 삭감 (가끔 실수함)
                            if (dist < 5 || dist > 60) score -= 100; 

                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    if ((enemyAhead || maxScore > 10) && bestMate) {
                        // ★ 오프사이드 발동 여부 확인 (실제로 패스하는 순간)
                        let receiverIsOffside = false;
                        if (p.team === 1 && bestMate.x > offsideLine1) receiverIsOffside = true;
                        if (p.team === 2 && bestMate.x < offsideLine2) receiverIsOffside = true;

                        if (receiverIsOffside) {
                            // 오프사이드 휘슬이 불리기 전 1초 대기 (실제 축구처럼 지연 판정)
                            state.phase = 'offside_pending';
                            state.setPieceTimer = 10; 
                            state.offsidePos = { x: bestMate.x, y: bestMate.y };
                            state.offsideTeam = p.team;
                            state.eventText = "부심 깃발을 듭니다...";
                        }

                        io.to(roomCode).emit('playSound', 'kick');
                        // ⬇️ ★ 패스 속도 조절하는 곳 ★ ⬇️
                        // 아래 나누는 숫자(26)를 키우면 패스가 느려지고, 줄이면 패스가 빨라집니다.
                        let power = ((p.stats && p.stats.pas ? p.stats.pas : 80) / 26); 
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y) || 1; 
                        state.ball.vx = ((bestMate.x - p.x) / d) * power;
                        state.ball.vy = ((bestMate.y - p.y) / d) * power + (Math.random()-0.5)*0.2;
                        p.cooldown = 10; 
                    } 
                    else {
                        let dodgeY = (p.y > 50) ? -1 : 1;
                        if (enemyAhead) { state.ball.vx = dir * 1.4; state.ball.vy = dodgeY * 1.9; } 
                        else { state.ball.vx = dir * 1.7; state.ball.vy = (Math.random() - 0.5) * 0.5; }
                        p.cooldown = 2;
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

    if (type === 'throw_in') {
        state.eventText = "스로인"; state.ball.y = state.ball.y <= 0 ? 2 : 98;
        state.ball.x = Math.max(2, Math.min(98, state.ball.x)); 
        let fieldPlayers = state.players.filter(p => p.role !== 'GK');
        let thrower = fieldPlayers.reduce((prev, curr) => (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev));
        thrower.x = state.ball.x; thrower.y = state.ball.y; thrower.cooldown = 15; state.throwerId = thrower.id; state.possessionTeam = thrower.team;
    } 
    else if (type === 'corner') {
        state.eventText = "코너킥"; state.possessionTeam = sideTeam === 1 ? 2 : 1;
        let goalX = sideTeam === 1 ? 2 : 98; state.ball.x = goalX; state.ball.y = (state.ball.y > 50) ? 98 : 2;
        state.players.forEach(p => { if(p.role !== 'GK') { p.x = goalX + (sideTeam === 1 ? 1 : -1) * (5 + Math.random()*20); p.y = 30 + Math.random() * 40; } });
        let kicker = state.players.find(p => p.team === state.possessionTeam && p.role === 'FW');
        if(kicker) { kicker.x = state.ball.x; kicker.y = state.ball.y; kicker.cooldown = 15; }
    }
    else if (type === 'goal_kick') {
        state.eventText = "골킥"; state.possessionTeam = sideTeam;
        let goalX = sideTeam === 1 ? 5 : 95; state.ball.x = goalX; state.ball.y = 50;
        state.players.forEach(p => {
            if (p.team === sideTeam) {
                if(p.role === 'DF') { p.x = goalX + (sideTeam===1?15:-15); p.y = p.baseY; } else if(p.role === 'MF') { p.x = 40; p.y = p.baseY; } else if(p.role === 'FW') { p.x = sideTeam===1?60:40; p.y = p.baseY; }
            } else { p.x = sideTeam===1? 50:50; }
        });
        let gk = state.players.find(p => p.team === sideTeam && p.role === 'GK');
        if(gk) { gk.x = state.ball.x; gk.y = state.ball.y; gk.cooldown = 15; }
    }
    // ★ 오프사이드 프리킥 세팅
    else if (type === 'offside') {
        state.eventText = "오프사이드 반칙!";
        state.possessionTeam = sideTeam; 
        state.ball.x = state.offsidePos.x; state.ball.y = state.offsidePos.y;
        state.players.forEach(p => {
            if (p.team === sideTeam) { p.x = state.ball.x + (sideTeam === 1 ? -5 : 5) + (Math.random()-0.5)*10; p.y = p.baseY; } 
            else { p.x = state.ball.x + (sideTeam === 1 ? 15 : -15); p.y = p.baseY; }
        });
        let kicker = state.players.reduce((prev, curr) => (curr.team === sideTeam && getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev));
        kicker.x = state.ball.x; kicker.y = state.ball.y; kicker.cooldown = 15;
    }
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
    setTimeout(() => { startMatchPhase(roomCode, true); }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
