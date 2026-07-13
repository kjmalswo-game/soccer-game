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

function getDistance(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); }
function getRole(posId) {
    if (!posId) return 'MF';
    if (posId.includes('B')) return 'DF'; 
    if (posId.includes('T') || posId.includes('W') || posId === 'CF') return 'FW'; 
    return 'MF'; 
}

function resetPositions(state, kickoffTeam) {
    state.ball = { x: 50, y: 50, vx: 0, vy: 0 };
    state.phase = 'play';
    state.isPaused = false;
    state.isKickoff = true;
    state.kickoffTeam = kickoffTeam;
    state.players.forEach(p => { 
        p.x = p.baseX; p.y = p.baseY; p.cooldown = 0; 
    });
    const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW');
    if (striker) { striker.x = 50; striker.y = 51; }
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
        rooms[roomCode] = {
            players: { [socket.id]: { id: 'player1', ready: false, team: [] } },
            settings: { timer: db.settings.draftTimers[1], formation: null },
            state: 'lobby', availablePlayers: [...db.players]
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode, db);
    });

    socket.on('joinRoom', (roomCode) => {
        if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length < 2) {
            rooms[roomCode].players[socket.id] = { id: 'player2', ready: false, team: [] };
            socket.join(roomCode);
            socket.emit('roomJoined', roomCode, db); 
            io.to(roomCode).emit('playerJoinedLobby'); 
        } else {
            socket.emit('error', '방이 가득 찼거나 존재하지 않는 코드입니다.');
        }
    });

    socket.on('setTimer', (roomCode, timerValue) => {
        if (rooms[roomCode]) { rooms[roomCode].settings.timer = timerValue; socket.to(roomCode).emit('timerUpdated', timerValue); }
    });

    socket.on('playerReady', (roomCode, formationId) => {
        const room = rooms[roomCode];
        if(!room || !room.players[socket.id]) return; 
        room.players[socket.id].formation = formationId;
        room.players[socket.id].ready = true;
        const playersArr = Object.values(room.players);
        if (playersArr.every(p => p.ready) && playersArr.length === 2) startDraftPhase(roomCode);
    });

    socket.on('playerPlaced', (roomCode, slotId, playerInfo) => {
        const room = rooms[roomCode];
        if(!room || !room.currentDraft) return;
        const isP1 = room.players[socket.id].id === 'player1';
        if (isP1 && room.currentDraft.p1Placed) return;
        if (!isP1 && room.currentDraft.p2Placed) return;

        room.players[socket.id].team.push({ slot: slotId, player: playerInfo });
        room.currentDraft.answers++;
        if (isP1) room.currentDraft.p1Placed = true;
        else room.currentDraft.p2Placed = true;

        if (room.currentDraft.answers === 2) { clearTimeout(room.draftTimeout); room.draftCount++; nextDraftTurn(roomCode); }
    });

    socket.on('swapPlayers', (roomCode, teamId, id1, id2) => {
        const room = rooms[roomCode];
        if(!room || !room.matchState) return;
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
    const room = rooms[roomCode];
    room.state = 'draft'; room.draftCount = 0;
    io.to(roomCode).emit('startDraft');
    nextDraftTurn(roomCode);
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
    
    room.draftTimeout = setTimeout(() => { 
        if(!room || !room.currentDraft) return;
        Object.keys(room.players).forEach(pId => {
            const pData = room.players[pId];
            const isP1 = pData.id === 'player1';
            const hasPlaced = isP1 ? room.currentDraft.p1Placed : room.currentDraft.p2Placed;
            if (!hasPlaced) {
                const filledSlots = pData.team.map(t => parseInt(t.slot));
                let emptySlot = -1;
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
    }, room.settings.timer * 1000 + 1000);
}

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode];
    room.state = 'match'; room.code = roomCode; 
    
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]], p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions, p2Formation = db.formations[p2Data.formation].positions;
        const gkStats = { spd: 85, sht: 85, pas: 80 }; 

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, 
            phase: 'play', setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이", isPaused: false, throwerId: null, gkHolder: null,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => {
                    const pos = p1Formation[t.slot];
                    return { ...t.player, team: 1, role: getRole(pos.id), posId: pos.id, x: pos.x / 2, y: pos.y, baseX: pos.x / 2, baseY: pos.y, cooldown: 0 };
                }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats, cooldown: 0 },
                ...p2Data.team.map((t, idx) => {
                    const pos = p2Formation[t.slot];
                    return { ...t.player, team: 2, role: getRole(pos.id), posId: pos.id, x: 100 - (pos.x / 2), y: 100 - pos.y, baseX: 100 - (pos.x / 2), baseY: 100 - pos.y, cooldown: 0 };
                }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', posId:'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats, cooldown: 0 }
            ]
        };
    } else {
        room.matchState.half = 2; room.matchState.ticks = 0; room.matchState.phase = 'play'; room.matchState.isPaused = false;
        resetPositions(room.matchState, 2);
    }

    if (!isSecondHalf) {
        resetPositions(room.matchState, 1);  // 첫 하프 킥오프 설정 통일 (isKickoff, striker 위치 등)
    }

    io.to(roomCode).emit('matchStarted', room.matchState);
    io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        if (state.isPaused) return; 
        state.ticks++;

        // --- 1. 세트피스 및 골키퍼 캐칭 마그네틱 홀드 ---
        if (state.phase !== 'play') {
            if (state.phase === 'gk_hold' && state.gkHolder) {
                state.ball.x = state.gkHolder.x + (state.gkHolder.team === 1 ? 1.5 : -1.5); 
                state.ball.y = state.gkHolder.y;
                state.ball.vx = 0; state.ball.vy = 0;
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
                            state.players.forEach(e => {
                                if (e.team !== p.team && getDistance(m.x, m.y, e.x, e.y) < minEnemyDist) minEnemyDist = getDistance(m.x, m.y, e.x, e.y);
                            });
                            let dFromGk = getDistance(p.x, p.y, m.x, m.y);
                            let score = (minEnemyDist * 5) - dFromGk;
                            let isForward = (p.team === 1 && m.x > p.x) || (p.team === 2 && m.x < p.x);
                            if (isForward) score += 30;
                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    if (bestMate) {
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                        state.ball.vx = ((bestMate.x - p.x) / d) * 5.5; 
                        state.ball.vy = ((bestMate.y - p.y) / d) * 5.5;
                    } else {
                        let dir = (p.team === 1) ? 1 : -1;
                        state.ball.vx = dir * 6.5; state.ball.vy = (p.y > 50) ? 3.5 : -3.5;
                    }
                    p.cooldown = 20; 

                    // 골키퍼가 던진 직후 근처 상대가 바로 가로채는 버그 방지 (요청 #3)
                    state.players.forEach(op => {
                        if (op.team !== p.team && getDistance(op.x, op.y, p.x, p.y) < 16) {
                            op.cooldown = Math.max(op.cooldown || 0, 9);
                        }
                    });
                } 
                else {
                    let dir = (state.possessionTeam === 1) ? 1 : -1;
                    if (state.phase === 'throw_in') {
                        let mates = state.players.filter(p => p.team === state.possessionTeam && p.id !== state.throwerId && p.role !== 'GK');
                        mates.sort((a,b) => getDistance(state.ball.x, state.ball.y, a.x, a.y) - getDistance(state.ball.x, state.ball.y, b.x, b.y));
                        let target = mates[0];
                        if(target) {
                            let dist = getDistance(state.ball.x, state.ball.y, target.x, target.y);
                            state.ball.vx = ((target.x - state.ball.x) / dist) * 3.0;
                            state.ball.vy = ((target.y - state.ball.y) / dist) * 3.0;
                        } else { state.ball.vx = dir * 2.5; state.ball.vy = 0; }
                    } else if (state.phase === 'corner') {
                        let targetX = (state.possessionTeam === 1) ? 90 : 10;
                        let targetY = 50 + (Math.random() - 0.5) * 15;
                        let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY);
                        state.ball.vx = ((targetX - state.ball.x) / dist) * 3.5;
                        state.ball.vy = ((targetY - state.ball.y) / dist) * 3.5;
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

        // --- 3. 소유권 및 거리 랭킹 계산 ---
        let distArr1 = [], distArr2 = [];
        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if(p.role !== 'GK') {
                if (p.team === 1) distArr1.push({p, dist});
                else distArr2.push({p, dist});
            }
        });
        distArr1.sort((a,b) => a.dist - b.dist);
        distArr2.sort((a,b) => a.dist - b.dist);

        let minDist1 = distArr1[0] ? distArr1[0].dist : Infinity;
        let minDist2 = distArr2[0] ? distArr2[0].dist : Infinity;

        if(minDist1 < minDist2 && minDist1 < 10) state.possessionTeam = 1;
        else if(minDist2 <= minDist1 && minDist2 < 10) state.possessionTeam = 2;
        const attTeam = state.possessionTeam;

        // --- 4. ★ 완벽한 지역 방어 및 변칙적 오프더볼 AI ---
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

            // ★ 스마트 다중 압박 체계
            let isPressing = false;
            if (p.role !== 'GK') {
                if (rank === 0) isPressing = true;
                else if (rank === 1 && isFinalThirdDef && distToBall < 15) isPressing = true;
                else if (rank === 1 && distToBall < 8) isPressing = true;
            }

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 2);
                targetY = Math.max(42, Math.min(58, state.ball.y)); 
                if(distToBall < 10) { targetX = state.ball.x; targetY = state.ball.y; }
            } 
            else if (isPressing) {
                targetX = state.ball.x; targetY = state.ball.y; 
            } 
            else if (attTeam === p.team) {
                // [개선됨] 공격 시 변칙적인 오프더볼 무브먼트 (사인파 난수를 이용한 스위칭 플레이 및 침투)
                // 시간(ticks)과 선수의 기본 위치를 조합해 매번 다른 공간을 찾아 들어가도록 설계
                let attackVariant = Math.sin(state.ticks / 30 + p.baseY); 
                
                if (p.role === 'DF') { 
                    targetX = Math.max(25, Math.min(75, state.ball.x - (dir * 18))); 
                    targetY = p.baseY + attackVariant * 5; // 풀백의 오버래핑 변주
                } 
                else if (p.role === 'MF') { 
                    targetX = Math.max(35, Math.min(65, state.ball.x + (dir * 12))); 
                    targetY = p.baseY + attackVariant * 15; // 미드필더들의 유기적인 스위칭
                } 
                else if (p.role === 'FW') { 
                    targetX = (p.team === 1) ? 88 + attackVariant * 5 : 12 - attackVariant * 5; 
                    targetY = p.baseY + attackVariant * 15; // 공격수의 대각선 침투 (더미 런)
                }
            } 
            else {
                // [수비 시 중앙 수비망]
                if (p.role === 'DF') { 
                    if (isFinalThirdDef) {
                        targetX = ownGoalX + (dir * 15);
                        targetY = p.baseY * 0.4 + 50 * 0.6; 
                    } else {
                        targetX = Math.max(15, Math.min(85, state.ball.x - (dir * 20))); 
                        targetY = p.baseY; 
                    }
                } 
                else if (p.role === 'MF') { 
                    if (isFinalThirdDef) {
                        targetX = ownGoalX + (dir * 25);
                        targetY = p.baseY * 0.5 + 50 * 0.5;
                    } else {
                        targetX = state.ball.x - (dir * 10); targetY = p.baseY; 
                    }
                } 
                else if (p.role === 'FW') { 
                    targetX = state.ball.x + (dir * 12); targetY = p.baseY;
                }
            }

            // 동료와 겹치지 않도록 밀어내기
            state.players.forEach(mate => {
                if (mate !== p && mate.team === p.team && mate.role !== 'GK') {
                    if (getDistance(p.x, p.y, mate.x, mate.y) < 12) { 
                        targetX += (p.x - mate.x) * 1.5; targetY += (p.y - mate.y) * 1.5;
                    }
                }
            });

            targetX = Math.max(3, Math.min(97, targetX));
            targetY = Math.max(3, Math.min(97, targetY));

            let moveSpeed = ((p.stats.spd || 80) / 100) * (0.85 + Math.random() * 0.3); 
            if (isPressing) moveSpeed *= 1.3; 
            
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 5. 터치 및 스마트 결정 로직 (킥오프 강제 후방 패스 + 패스 속도 조정 + 슈팅 강화/변칙 + GK 캐치 범위 축소) ---
            let touchRadius = p.role === 'GK' ? 2.7 : 3;   // 골키퍼 캐칭 범위 축소 (요청 #4)
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

                // ★ 1. 처음 킥오프: 반드시 뒤에 있는 같은 팀 동료에게 성공 패스 (직접 설정으로 100% 성공 보장)
                if (state.isKickoff && p.team === state.kickoffTeam) {
                    let teammates = state.players.filter(m => 
                        m.team === p.team && m.role !== 'GK' && m.id !== p.id && getDistance(m.x, m.y, state.ball.x, state.ball.y) > 3
                    );
                    // 뒤에 있는 선수 우선 (team1은 x 작은 쪽, team2는 x 큰 쪽)
                    let behind = teammates.filter(m => (p.team === 1 ? m.x < state.ball.x - 2 : m.x > state.ball.x + 2));
                    let targetMate = behind.length > 0 ? behind[Math.floor(Math.random() * behind.length)] : teammates[0];
                    
                    if (targetMate) {
                        let d = getDistance(p.x, p.y, targetMate.x, targetMate.y) || 1;
                        // 강제 성공 패스 (속도 적당히, 정확히 타겟 방향)
                        let passPower = 2.6;
                        state.ball.vx = ((targetMate.x - p.x) / d) * passPower;
                        state.ball.vy = ((targetMate.y - p.y) / d) * passPower;
                        io.to(roomCode).emit('playSound', 'kick');
                        p.cooldown = 12;
                        state.isKickoff = false;
                        return;
                    }
                    state.isKickoff = false; // fallback
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
                    // 슈팅 확률 + 파워 대폭 상향 (요청 #3: 약한 슈팅 개선)
                    let angleFactor = 1 - Math.min(1, Math.abs(p.y - 50) / 20);
                    let spaceFactor = enemyAhead ? 0.3 : 1.0;
                    let shootProb = Math.min(0.92, 0.48 + angleFactor * 0.35 + spaceFactor * 0.22);
                    if (Math.random() < shootProb && (!enemyAhead || Math.random() < 0.55)) {
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = (p.stats.sht || 85) / 11.6 * (0.90 + Math.random() * 0.25);  // 더 강한 슈팅
                        // 에임 분산 대폭 증가 (가운데만 차는 문제 완화)
                        let aimSpread = 11 + Math.random() * 11;
                        let aimY = 50 + (Math.random() - 0.5) * aimSpread * 0.95;
                        aimY = Math.max(38, Math.min(62, aimY));
                        let dx = targetGoalX - p.x;
                        let dy = aimY - p.y;
                        let d = Math.sqrt(dx*dx + dy*dy) || 1;
                        state.ball.vx = (dx / d) * power * (0.92 + Math.random()*0.14);
                        state.ball.vy = (dy / d) * power * (0.90 + Math.random()*0.18) + (Math.random()-0.5)*0.42;
                        p.cooldown = 8 + Math.floor(Math.random()*5);
                    } else {
                        // fall to pass/dribble
                        doPassOrDribble();
                    }
                } 
                else {
                    doPassOrDribble();
                }
            }

            // 헬퍼 함수 (코드 중복 방지)
            function doPassOrDribble() {
                let isFinalThirdAtt = (p.team === 1 && p.x > 66) || (p.team === 2 && p.x < 34);
                let isWinger = p.y < 25 || p.y > 75;

                if (isFinalThirdAtt && isWinger && Math.random() < 0.55) {
                    let strikersInBox = state.players.filter(m => m.team === p.team && m !== p && Math.abs(m.y - 50) < 30 && m.role !== 'DF');
                    if (strikersInBox.length > 0) {
                        let target = strikersInBox[Math.floor(Math.random() * strikersInBox.length)];
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = (p.stats.pas || 80) / 24;   // 패스/크로스 속도 하향 (요청 #2)
                        let d = getDistance(p.x, p.y, target.x, target.y);
                        state.ball.vx = ((target.x - p.x) / d) * power;
                        state.ball.vy = ((target.y - p.y) / d) * power + (Math.random()-0.5)*0.5;
                        p.cooldown = 10; 
                        return; 
                    }
                }

                let bestMate = null; let maxScore = -999;
                state.players.forEach(m => {
                    if (m.team === p.team && m !== p && m.role !== 'GK') {
                        let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x); 
                        let dist = getDistance(p.x, p.y, m.x, m.y);
                        let visionCreativity = (Math.random() * 38) - 9;
                        let score = (forwardDist * 4) - dist + visionCreativity; 
                        let enemyNearMate = false;
                        state.players.forEach(e => {
                            if (e.team !== p.team && getDistance(m.x, m.y, e.x, e.y) < 6) enemyNearMate = true;
                        });
                        if (enemyNearMate) score -= 80;
                        if (dist < 5 || dist > 60) score -= 100; 
                        if (score > maxScore) { maxScore = score; bestMate = m; }
                    }
                });

                if ((enemyAhead || maxScore > 10) && bestMate) {
                    // 패스 속도 하향 조정 (요청 #2)
                    io.to(roomCode).emit('playSound', 'kick');
                    let power = (p.stats.pas || 80) / 26; 
                    let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                    state.ball.vx = ((bestMate.x - p.x) / d) * power;
                    state.ball.vy = ((bestMate.y - p.y) / d) * power + (Math.random()-0.5)*0.2;
                    p.cooldown = 10; 
                } 
                else {
                    let dodgeY = (p.y > 50) ? -1 : 1;
                    if (enemyAhead) {
                        state.ball.vx = dir * 1.4;
                        state.ball.vy = dodgeY * 1.9; 
                    } else {
                        state.ball.vx = dir * 1.7;
                        state.ball.vy = (Math.random() - 0.5) * 0.5;
                    }
                    p.cooldown = 2;
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
    
    setTimeout(() => { resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1); io.to(room.code).emit('playSound', 'whistle'); }, 3000);
}

function setupSetPiece(state, type, sideTeam = 1) {
    state.phase = type; state.setPieceTimer = 15; state.ball.vx = 0; state.ball.vy = 0;

    if (type === 'throw_in') {
        state.eventText = "스로인";
        state.ball.y = state.ball.y <= 0 ? 2 : 98;
        let thrower = state.players.reduce((prev, curr) => 
            (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev)
        );
        thrower.x = state.ball.x; thrower.y = state.ball.y;
        thrower.cooldown = 15; 
        state.throwerId = thrower.id; state.possessionTeam = thrower.team;
    } 
    else if (type === 'corner') {
        state.eventText = "코너킥"; state.possessionTeam = sideTeam === 1 ? 2 : 1;
        let goalX = sideTeam === 1 ? 2 : 98;
        state.ball.x = goalX; state.ball.y = (state.ball.y > 50) ? 98 : 2;
        
        state.players.forEach(p => {
            if(p.role !== 'GK') { p.x = goalX + (sideTeam === 1 ? 1 : -1) * (5 + Math.random()*20); p.y = 30 + Math.random() * 40; }
        });
        let kicker = state.players.find(p => p.team === state.possessionTeam && p.role === 'FW');
        if(kicker) { kicker.x = state.ball.x; kicker.y = state.ball.y; kicker.cooldown = 15; }
    }
    else if (type === 'goal_kick') {
        state.eventText = "골킥"; state.possessionTeam = sideTeam;
        let goalX = sideTeam === 1 ? 5 : 95;
        state.ball.x = goalX; state.ball.y = 50;
        
        state.players.forEach(p => {
            if (p.team === sideTeam) {
                if(p.role === 'DF') { p.x = goalX + (sideTeam===1?15:-15); p.y = p.baseY; }
                else if(p.role === 'MF') { p.x = 40; p.y = p.baseY; }
                else if(p.role === 'FW') { p.x = sideTeam===1?60:40; p.y = p.baseY; }
            } else { p.x = sideTeam===1? 50:50; }
        });
        let gk = state.players.find(p => p.team === sideTeam && p.role === 'GK');
        if(gk) { gk.x = state.ball.x; gk.y = state.ball.y; gk.cooldown = 15; }
    }
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
    setTimeout(() => { startMatchPhase(roomCode, true); }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
