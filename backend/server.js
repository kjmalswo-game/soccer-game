const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let db;
try { 
    db = JSON.parse(fs.readFileSync('database.json', 'utf8')); 
} catch(e) { 
    console.error("🔥 database.json 파일 문법 에러!:", e); 
}

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
    state.lastPasserId = null; 
    state.players.forEach(p => { 
        p.x = p.baseX; 
        p.y = p.baseY; 
        p.cooldown = 0; 
        p.duelCooldown = 0; 
    });
    
    // 후반전 대응 방향 설정
    let leftTeam = state.half === 1 ? 1 : 2;
    const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW') || state.players.find(p => p.team === kickoffTeam);
    if (striker) { 
        striker.x = kickoffTeam === leftTeam ? 47 : 53; 
        striker.y = 50; 
        state.kickoffStrikerId = striker.id;
    } else {
        state.kickoffStrikerId = null;
    }
}

function emitUpdate(roomCode, state) {
    let totalTicks = state.ticks;
    let gameSeconds = (totalTicks / 10) * (db.settings.gameMinutesPerHalf * 60 / db.settings.halfDurationRealSeconds);
    if (state.half === 2) gameSeconds += db.settings.gameMinutesPerHalf * 60; 
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
            state: 'lobby', 
            availablePlayers: [...db.players] 
        };
        socket.join(roomCode); 
        socket.emit('roomCreated', roomCode, db);
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
            socket.join(roomCode); 
            socket.emit('roomJoined', roomCode, db); 
            io.to(roomCode).emit('playerJoinedLobby'); 
        } else { 
            socket.emit('error', '방이 가득 찼거나 존재하지 않는 코드입니다.'); 
        }
    });

    socket.on('setTimer', (roomCode, timerValue) => { 
        if (rooms[roomCode]) { 
            rooms[roomCode].settings.timer = timerValue; 
            socket.to(roomCode).emit('timerUpdated', timerValue); 
        } 
    });

    socket.on('playerReady', (roomCode, formationId) => {
        const room = rooms[roomCode]; 
        if(!room || !room.players[socket.id]) return; 
        room.players[socket.id].formation = formationId; 
        room.players[socket.id].ready = true;
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
        const room = rooms[roomCode]; 
        if(!room || !room.currentDraft) return;
        const isP1 = room.players[socket.id].id === 'player1';
        const expectedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
        if (!playerInfo || playerInfo.id !== expectedPlayer.id || (isP1 && room.currentDraft.p1Placed) || (!isP1 && room.currentDraft.p2Placed)) return;
        room.players[socket.id].team.push({ slot: slotId, player: playerInfo });
        room.currentDraft.answers++;
        if (isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
        if (room.currentDraft.answers === 2) { 
            clearTimeout(room.draftTimeout); 
            room.draftCount++; 
            nextDraftTurn(roomCode); 
        }
    });

    socket.on('swapPlayers', (roomCode, teamId, id1, id2) => {
        const room = rooms[roomCode]; 
        if(!room || !room.matchState) return;
        const p1 = room.matchState.players.find(p => p.team === teamId && p.id == id1);
        const p2 = room.matchState.players.find(p => p.team === teamId && p.id == id2);
        if(p1 && p2) {
            let tempX = p1.baseX, tempY = p1.baseY, tempRole = p1.role, tempPosId = p1.posId;
            p1.baseX = p2.baseX; p1.baseY = p2.baseY; p1.role = p2.role; p1.posId = p2.posId; p1.x = p1.baseX; p1.y = p1.baseY;
            p2.baseX = tempX; p2.baseY = tempY; p2.role = tempRole; p2.posId = tempPosId; p2.x = p2.baseX; p2.y = p2.baseY;
        }
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.players[socket.id]) {
                if (room.matchInterval) clearInterval(room.matchInterval);
                if (room.draftTimeout) clearTimeout(room.draftTimeout);
                socket.to(roomCode).emit('error', '상대방과의 연결이 끊어져 방이 소멸되었습니다.');
                delete rooms[roomCode];
            }
        }
    });
});

function startDraftPhase(roomCode) {
    const room = rooms[roomCode]; 
    room.state = 'draft'; 
    room.draftCount = 0;
    io.to(roomCode).emit('startDraft'); 
    nextDraftTurn(roomCode);
}

function nextDraftTurn(roomCode) {
    const room = rooms[roomCode];
    if (room.draftCount >= 10 || room.availablePlayers.length < 2) { 
        startMatchPhase(roomCode, false); 
        return; 
    }
    
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
            const pData = room.players[pId]; 
            const isP1 = pData.id === 'player1';
            const hasPlaced = isP1 ? room.currentDraft.p1Placed : room.currentDraft.p2Placed;
            if (!hasPlaced) {
                const filledSlots = pData.team.map(t => parseInt(t.slot)); 
                let emptySlot = -1;
                for(let i = 0; i < 10; i++) { 
                    if(!filledSlots.includes(i)) { emptySlot = i; break; } 
                }
                if(emptySlot !== -1) {
                    const assignedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
                    pData.team.push({ slot: emptySlot, player: assignedPlayer });
                    io.to(pId).emit('autoPlaced', emptySlot, assignedPlayer); 
                }
                room.currentDraft.answers++;
                if(isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
            }
        });
        if (room.currentDraft.answers >= 2) { 
            room.draftCount++; 
            nextDraftTurn(roomCode); 
        }
    }, room.settings.timer * 1000 + 500); 
}

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode]; 
    room.state = 'match'; 
    room.code = roomCode; 
    
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]], p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions, p2Formation = db.formations[p2Data.formation].positions;
        const gkStats = { spd: 85, sht: 85, pas: 80 }; 

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, 
            phase: 'play', setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이", isPaused: false, throwerId: null, kickerId: null, gkHolder: null, passTargetId: null,
            lastPasserId: null,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => { 
                    return { ...t.player, team: 1, role: getRole(p1Formation[t.slot].id), posId: p1Formation[t.slot].id, x: p1Formation[t.slot].x / 2, y: p1Formation[t.slot].y, baseX: p1Formation[t.slot].x / 2, baseY: p1Formation[t.slot].y, cooldown: 0, duelCooldown: 0 }; 
                }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats, cooldown: 0, duelCooldown: 0 },
                ...p2Data.team.map((t, idx) => { 
                    return { ...t.player, team: 2, role: getRole(p2Formation[t.slot].id), posId: p2Formation[t.slot].id, x: 100 - (p2Formation[t.slot].x / 2), y: 100 - p2Formation[t.slot].y, baseX: 100 - (p2Formation[t.slot].x / 2), baseY: 100 - p2Formation[t.slot].y, cooldown: 0, duelCooldown: 0 }; 
                }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', posId:'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats, cooldown: 0, duelCooldown: 0 }
            ]
        };
    } else {
        room.matchState.half = 2; 
        room.matchState.ticks = 0; 
        room.matchState.phase = 'play'; 
        room.matchState.isPaused = false; 
        room.matchState.passTargetId = null;
        room.matchState.lastPasserId = null;
        room.matchState.players.forEach(p => {
            p.baseX = 100 - p.baseX;
            p.baseY = 100 - p.baseY;
        });
    }

    resetPositions(room.matchState, isSecondHalf ? 2 : 1);  
    io.to(roomCode).emit('matchStarted', room.matchState); 
    io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        try {
            const state = room.matchState;
            if (state.isPaused) return; 
            state.ticks++;

            // ★ 후반전 진영 교체 대응 기준 변수 (가장 중요)
            let leftTeam = state.half === 1 ? 1 : 2;
            let rightTeam = state.half === 1 ? 2 : 1;

            // 0. 하프타임 및 풀타임 로직
            let halfSeconds = (db.settings.gameMinutesPerHalf * 60); 
            let currentSeconds = (state.ticks / 10) * (halfSeconds / db.settings.halfDurationRealSeconds);
            
            if (currentSeconds >= halfSeconds) {
                clearInterval(room.matchInterval);
                if (state.half === 1) {
                    startHalfTime(roomCode);
                } else {
                    io.to(roomCode).emit('matchEnded', state.score);
                    io.to(roomCode).emit('playSound', 'whistle');
                }
                return;
            }

            if (isNaN(state.ball.x) || isNaN(state.ball.y)) { state.ball.x = 50; state.ball.y = 50; state.ball.vx = 0; state.ball.vy = 0; }
            state.players.forEach(p => {
                if (isNaN(p.x) || isNaN(p.y)) { p.x = p.baseX; p.y = p.baseY; }
                if (isNaN(p.cooldown)) p.cooldown = 0;
                if (isNaN(p.duelCooldown)) p.duelCooldown = 0;
            });

            // --- 1. 세트피스 처리 ---
            if (state.phase !== 'play') {
                if (state.phase === 'gk_hold' && state.gkHolder) {
                    state.ball.x = state.gkHolder.x + (state.gkHolder.team === leftTeam ? 1.5 : -1.5); 
                    state.ball.y = state.gkHolder.y; state.ball.vx = 0; state.ball.vy = 0;
                }

                state.setPieceTimer--;
                if (state.setPieceTimer <= 0) {
                    io.to(roomCode).emit('playSound', 'kick');
                    
                    if (state.phase === 'gk_hold' && state.gkHolder) {
                        let p = state.gkHolder;
                        let bestMate = null; let maxScore = -999;
                        let dir = (p.team === leftTeam) ? 1 : -1;
                        
                        state.players.forEach(m => {
                            if (m.team === p.team && m.role !== 'GK') {
                                let minEnemyDist = Infinity;
                                state.players.forEach(e => { if (e.team !== p.team) { let d = getDistance(m.x, m.y, e.x, e.y); if(d < minEnemyDist) minEnemyDist = d; } });
                                
                                let forwardDist = (p.team === leftTeam) ? (m.x - p.x) : (p.x - m.x);
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
                            state.lastPasserId = p.id; 
                            if (d > 35) { state.ball.airTicks = Math.max(4, Math.floor(d / 4.5)); state.eventText = "🧤 키퍼 롱 패스 전개!"; }
                        } else {
                            state.ball.vx = dir * 7.5; state.ball.vy = (p.y > 50) ? 3.5 : -3.5; state.ball.airTicks = 5;
                        }
                        p.cooldown = 20; 
                    } 
                    else {
                        let dir = (state.possessionTeam === leftTeam) ? 1 : -1;
                        if (state.phase === 'throw_in') {
                            let fieldPlayers = state.players.filter(p => p.role !== 'GK' && p.id !== state.throwerId);
                            let mates = fieldPlayers.filter(p => p.team === state.possessionTeam);
                            
                            // 전방에만 주지 않고, 상대가 멀리 있는(>6) 안전한 동료들을 찾음
                            let safeMates = mates.filter(m => {
                                let minE = Math.min(...state.players.filter(e => e.team !== m.team).map(e => getDistance(m.x, m.y, e.x, e.y)));
                                return minE > 6;
                            });
                            if (safeMates.length === 0) safeMates = mates; // 안전한 곳이 없으면 원래대로
                            
                            // 거리순 정렬 후 가장 가까운 3명 중 랜덤으로 선택 (백패스 포함)
                            safeMates.sort((a,b) => getDistance(state.ball.x, state.ball.y, a.x, a.y) - getDistance(state.ball.x, state.ball.y, b.x, b.y));
                            let target = safeMates[Math.floor(Math.random() * Math.min(3, safeMates.length))];
                            
                            if(target) {
                                let dist = getDistance(state.ball.x, state.ball.y, target.x, target.y) || 1;
                                state.ball.vx = ((target.x - state.ball.x) / dist) * 3.5; state.ball.vy = ((target.y - state.ball.y) / dist) * 3.5;
                                state.passTargetId = target.id;
                                state.lastPasserId = state.throwerId; 
                                if (dist > 15) { state.ball.airTicks = Math.max(2, Math.floor(dist / 2.2)); state.eventText = "🙌 롱 스로인!"; }
                            } else { state.ball.vx = dir * 2.5; state.ball.vy = 0; }
                        }
                        else if (state.phase === 'corner') {
                            let targetX = (state.possessionTeam === leftTeam) ? 90 : 10;
                            let targetY = 50 + (Math.random() - 0.5) * 15;
                            let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                            state.ball.vx = ((targetX - state.ball.x) / dist) * 4.8; state.ball.vy = ((targetY - state.ball.y) / dist) * 4.8;
                            state.ball.airTicks = Math.max(4, Math.floor(dist / 4.0));
                            state.lastPasserId = state.kickerId; 
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
                    state.phase = 'play'; state.gkHolder = null; state.throwerId = null; state.kickerId = null;
                }
                if (state.phase !== 'play' && state.phase !== 'gk_hold') { emitUpdate(roomCode, state); return; }
            }

            // --- 2. 물리 연산 ---
            if (state.phase === 'play') {
                state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
                state.ball.vx *= 0.90; state.ball.vy *= 0.90; 
                if (state.ball.airTicks && state.ball.airTicks > 0) state.ball.airTicks--;
                if (state.ball.shotTicks && state.ball.shotTicks > 0) state.ball.shotTicks--;
                
                let speedSq = state.ball.vx ** 2 + state.ball.vy ** 2;
                
                // ★ 슈팅 시 최고 속도 제한(캡)을 169(초속 13)로 대폭 상향하여 대포알 슈팅 보장
                let maxSpeedSq = (state.ball.shotTicks > 0) ? 169 : 25; 
                
                if (speedSq > maxSpeedSq) { 
                    let speed = Math.sqrt(speedSq);
                    let cap = Math.sqrt(maxSpeedSq);
                    state.ball.vx = (state.ball.vx / speed) * cap;
                    state.ball.vy = (state.ball.vy / speed) * cap;
                }
            }

            // --- 3. 소유권 계산 및 루즈볼 판정 ---
            let distArr1 = [], distArr2 = [];
            state.players.forEach(p => {
                if (p.role !== 'GK') {
                    let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                    if (p.team === 1) distArr1.push({p, dist}); 
                    else distArr2.push({p, dist});
                }
            });
            
            let minDist1 = distArr1.length > 0 ? Math.min(...distArr1.map(o => o.dist)) : Infinity;
            let minDist2 = distArr2.length > 0 ? Math.min(...distArr2.map(o => o.dist)) : Infinity;

            if(minDist1 < minDist2 && minDist1 < 8) state.possessionTeam = 1;
            else if(minDist2 <= minDist1 && minDist2 < 8) state.possessionTeam = 2;
            
            let attTeam = state.possessionTeam;
            let isLooseBall = (minDist1 > 6 && minDist2 > 6);
            
            // ★ 루즈볼 시 특정 선수 지정 해제
            if (isLooseBall) state.passTargetId = null; 

            let pTargetX = isLooseBall ? state.ball.x + (state.ball.vx * 3) : state.ball.x;
            let pTargetY = isLooseBall ? state.ball.y + (state.ball.vy * 3) : state.ball.y;

            let ballCarrier = state.players.find(p => p.team === attTeam && getDistance(p.x, p.y, state.ball.x, state.ball.y) < 4);

            distArr1.sort((a,b) => a.dist - b.dist);
            distArr2.sort((a,b) => a.dist - b.dist);

            let defLineLeft = 15, defLineRight = 85; 
            state.players.forEach(p => {
                if (p.role === 'DF') {
                    if (p.team === leftTeam && p.x > defLineLeft) defLineLeft = p.x;
                    if (p.team === rightTeam && p.x < defLineRight) defLineRight = p.x;
                }
            });

            // --- 4. 오프더볼 AI ---
            state.players.forEach(p => {
                if (p.cooldown > 0) p.cooldown--;
                if (p.duelCooldown > 0) p.duelCooldown--; 
                
                let targetX = p.baseX, targetY = p.baseY;
                let dir = (p.team === leftTeam) ? 1 : -1;
                let targetGoalX = (p.team === leftTeam) ? 100 : 0;
                let isPressing = false;
                p.isMakingRun = false;

                let organicX = Math.sin(state.ticks / 15 + p.baseX) * 2.5;
                let organicY = Math.cos(state.ticks / 18 + p.baseY) * 2.5;
                
                if (state.phase !== 'play' || state.setPieceTimer > 0) {
                    if (p.role === 'GK') { targetX = (p.team===leftTeam?5:95); targetY = 50; }
                    else if (state.phase === 'throw_in' && p.id === state.throwerId) { targetX = state.ball.x; targetY = state.ball.y; }
                    else if (state.phase === 'corner' && p.id === state.kickerId) { targetX = state.ball.x; targetY = state.ball.y; }
                    
                    else if (state.phase === 'corner') {
                        let cAttTeam = state.possessionTeam;
                        let goalX = (cAttTeam === leftTeam) ? 88 : 12; 
                        let cDir = (cAttTeam === leftTeam) ? 1 : -1;

                        if (p.team === cAttTeam) {
                            let fieldAttackers = state.players.filter(p2 => p2.team === cAttTeam && p2.role !== 'GK' && p2.id !== state.kickerId);
                            let sortedBySht = [...fieldAttackers].sort((a, b) => {
                                let aSht = (a.stats && a.stats.sht) ? a.stats.sht : 80;
                                let bSht = (b.stats && b.stats.sht) ? b.stats.sht : 80;
                                return aSht - bSht;
                            });
                            
                            let stayBackIds = sortedBySht.slice(0, 2).map(p2 => p2.id);

                            if (stayBackIds.includes(p.id)) {
                                targetX = 50 - (cDir * 6);
                                targetY = p.baseY;
                            } else {
                                let actionIndex = fieldAttackers.filter(p2 => !stayBackIds.includes(p2.id)).indexOf(p);
                                if (actionIndex === 0) { targetX = goalX - (cDir * 3); targetY = (state.ball.y > 50) ? 62 : 38; } 
                                else if (actionIndex === 1) { targetX = goalX - (cDir * 2); targetY = (state.ball.y > 50) ? 38 : 62; } 
                                else if (actionIndex === 2) { targetX = goalX - (cDir * 10); targetY = 50; } 
                                else if (actionIndex === 3) { targetX = goalX - (cDir * 18); targetY = 50 + (organicY > 0 ? 12 : -12); } 
                                else { targetX = goalX - (cDir * (5 + Math.random() * 8)); targetY = 25 + Math.random() * 50; }
                            }
                        } else {
                            let myGoalX = (p.team === leftTeam) ? 5 : 95;
                            let defDir = (p.team === leftTeam) ? 1 : -1;
                            let idx = state.players.filter(p2 => p2.team === p.team && p2.role !== 'GK').indexOf(p);
                            targetX = myGoalX + (defDir * (2 + (idx % 3) * 4));
                            targetY = 28 + (idx * 5) % 44;
                        }
                    } else {
                        targetX = (p.team === leftTeam) ? p.baseX * 0.8 : 100 - ((100 - p.baseX) * 0.8); 
                        targetY = p.baseY; 
                    }
                } 
                else if (state.isKickoff) {
                    if (p.id === state.kickoffStrikerId) { targetX = 50; targetY = 50; isPressing = true; } 
                }
                else {
                    let myDistArr = (p.team === 1) ? distArr1 : distArr2;
                    let rankObj = myDistArr.find(obj => obj.p === p);
                    let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
                    let distToBall = rankObj ? rankObj.dist : 999;

                    if (p.role === 'GK') {
                        let myGoalX = p.team === leftTeam ? 0 : 100;
                        let bdx = state.ball.x - myGoalX; let bdy = state.ball.y - 50;
                        let bdist = Math.sqrt(bdx*bdx + bdy*bdy) || 1;
                        let advance = Math.max(2, 12 - (bdist * 0.15));
                        targetX = myGoalX + (bdx / bdist) * advance;
                        targetY = 50 + (bdy / bdist) * advance;

                        if (p.team === leftTeam) targetX = Math.max(2, Math.min(15, targetX));
                        else targetX = Math.max(85, Math.min(98, targetX));
                        targetY = Math.max(30, Math.min(70, targetY));
                    }
                    else if (attTeam !== p.team) {
                        // ★ 수비 시 공의 위치에 따라 전체 라인이 공 쪽으로 쏠림 (지역 방어)
                        let shiftY = (state.ball.y - 50) * 0.4; 
                        
                        // ★ [핵심 개선 1] 센터백과 풀백이 중앙으로 간격을 좁혀 골대 앞을 방어 (Pinch In)
                        let pinchFactor = 1.0;
                        if (p.posId === 'CB') pinchFactor = 0.2; // 센터백은 중앙(50)에 극도로 가깝게 밀집
                        else if (p.role === 'DF') pinchFactor = 0.6; // 풀백도 중앙으로 좁힘
                        else if (p.role === 'MF') pinchFactor = 0.75; 

                        let blockY = 50 + (p.baseY - 50) * pinchFactor + shiftY + organicY;
                        
                        // 자기 골대 근처(페널티 박스 부근)일수록 더 촘촘하게 중앙 밀집
                        let distToOwnGoal = Math.abs(p.x - (p.team === leftTeam ? 0 : 100));
                        if (distToOwnGoal < 25) {
                            blockY = 50 + (blockY - 50) * 0.5;
                        }

                        let blockX = p.baseX + organicX;
                        if (p.role === 'FW') blockX = state.ball.x - (dir * 8);
                        else if (p.role === 'MF') blockX = Math.max(25, Math.min(75, state.ball.x - (dir * 18)));
                        else if (p.role === 'DF') blockX = Math.max(10, Math.min(90, state.ball.x - (dir * 28)));

                        if (isLooseBall && rank === 0) {
                            targetX = pTargetX + (p.id % 3 - 1) * 0.5; 
                            targetY = pTargetY + (p.id % 2 === 0 ? 0.5 : -0.5); 
                            isPressing = true;
                        }
                        else if (!isLooseBall && rank === 0 && distToBall < 18) { 
                            targetX = state.ball.x; targetY = state.ball.y; isPressing = true; 
                        } 
                        else if (!isLooseBall && rank === 1 && distToBall < 12) { 
                            targetX = state.ball.x - (dir*4); targetY = state.ball.y; 
                        } 
                        else { 
                            targetX = blockX; targetY = Math.max(10, Math.min(90, blockY)); 
                        }
                    }
                    else if (attTeam === p.team) {
                        let isChasingBall = (state.passTargetId === p.id) || (!state.passTargetId && rank === 0 && distToBall < 15) || (isLooseBall && rank === 0);
                        
                        if (isChasingBall) {
                            targetX = state.ball.x + (state.ball.vx*2); 
                            targetY = state.ball.y + (state.ball.vy*2); 
                            isPressing = true; 
                        }
                        else if (ballCarrier && p.id === ballCarrier.id) {
                            targetX = state.ball.x + (dir * 6); 
                            targetY = state.ball.y;
                        }
                        else {
                            let inFinalThird = (p.team === leftTeam && state.ball.x > 65) || (p.team === rightTeam && state.ball.x < 35);
                            let inAttackingHalf = (p.team === leftTeam && state.ball.x > 50) || (p.team === rightTeam && state.ball.x < 50);
                            let offsideLine = (p.team === leftTeam) ? defLineRight : defLineLeft;

                            if (p.posId === 'CB') {
                                let maxPushX = (p.team === leftTeam) ? (inAttackingHalf ? 55 : 46) : (inAttackingHalf ? 45 : 54); 
                                let cbTargetX = (p.team === leftTeam) ? Math.min(maxPushX, state.ball.x - 20) : Math.max(maxPushX, state.ball.x + 20);
                                targetX = p.baseX + (dir * Math.max(0, (p.team === leftTeam ? cbTargetX - p.baseX : p.baseX - cbTargetX)));
                                // 빌드업 시 중앙을 비우고 좌우로 살짝 벌려서 패스길 창출 (Lateral Movement)
                                targetY = 50 + (p.baseY - 50) * 1.2 + organicY;
                            }
                            else if (p.posId === 'LB' || p.posId === 'RB') {
                                if (inAttackingHalf) {
                                    targetX = state.ball.x + (dir * 15); 
                                    let goalLine = (p.team === leftTeam) ? 95 : 5;
                                    if (dir === 1 && targetX > goalLine) targetX = goalLine;
                                    if (dir === -1 && targetX < goalLine) targetX = goalLine;
                                    
                                    // [핵심 개선 2] 풀백이 너무 사이드에 박히지 않고, 페널티 박스 모서리 부근(언더랩)으로 좁혀서 침투
                                    targetY = 50 + (p.baseY - 50) * 0.7; 
                                    p.isMakingRun = true;
                                } else {
                                    let fbAdvance = (p.team === leftTeam) ? state.ball.x - 5 : state.ball.x + 5;
                                    targetX = p.baseX + (dir * Math.max(0, (p.team === leftTeam ? fbAdvance - p.baseX : p.baseX - fbAdvance) * 0.8));
                                    targetY = p.baseY + organicY;
                                }
                            }
                            else if (p.role === 'MF') {
                                let isDM = p.posId.includes('DM');
                                let isAM = p.posId.includes('AM');
                                let isWing = p.posId.includes('LM') || p.posId.includes('RM') || p.posId.includes('LW') || p.posId.includes('RW');

                                if (isDM) {
                                    let dmAdvance = (p.team === leftTeam) ? state.ball.x - 12 : state.ball.x + 12;
                                    targetX = inAttackingHalf ? state.ball.x - (dir * 12) : p.baseX + (dir * Math.max(0, (p.team === leftTeam ? dmAdvance - p.baseX : p.baseX - dmAdvance) * 0.8));
                                    targetY = p.baseY + organicY;
                                } else {
                                    if (inAttackingHalf) {
                                        targetX = targetGoalX - (dir * (isWing ? 8 : 15));
                                        
                                        // [핵심 개선 2] 윙어들이 직선으로만 뛰지 않고 중앙(하프스페이스/박스 안)으로 파고드는 '컷 인사이드' 움직임
                                        if (isWing) {
                                            let cutInsideY = 50 + (p.baseY - 50) * 0.3; // 윙어가 박스 안쪽으로 70% 좁혀 들어옴
                                            targetY = cutInsideY + organicY;
                                        } else {
                                            targetY = p.baseY + (Math.random() - 0.5) * 20; // 중앙 미드필더는 좌우로 폭넓게 스위칭
                                        }
                                        p.isMakingRun = true;
                                    } else {
                                        let spaceX = state.ball.x + (dir * 10); 
                                        let spaceY = p.baseY + (state.ball.y - p.baseY) * 0.35;
                                        let bestY = spaceY;
                                        let maxFoundSpace = -Infinity;
                                        
                                        // 좌우(Y축) 빈 공간 탐색 범위를 넓혀서 횡으로 활발하게 이동함 (-15, 0, 15)
                                        [-15, 0, 15].forEach(offset => {
                                            let testY = spaceY + offset;
                                            if (testY < 5 || testY > 95) return;
                                            let localMin = Infinity;
                                            state.players.forEach(e => {
                                                if (e.team !== p.team && e.role !== 'GK') {
                                                    let dist = getDistance(spaceX, testY, e.x, e.y);
                                                    if (dist < localMin) localMin = dist;
                                                }
                                            });
                                            if (localMin > maxFoundSpace) {
                                                maxFoundSpace = localMin;
                                                bestY = testY;
                                            }
                                        });
                                        targetX = spaceX + organicX;
                                        targetY = bestY + organicY;
                                    }
                                }
                            }
                            else if (p.role === 'FW') {
                                if (inAttackingHalf) {
                                    let nearestDef = state.players
                                        .filter(e => e.team !== p.team && e.role !== 'GK')
                                        .reduce((prev, curr) => (getDistance(p.x, p.y, curr.x, curr.y) < getDistance(p.x, p.y, prev.x, prev.y) ? curr : prev), state.players[0]);

                                    if (nearestDef && getDistance(p.x, p.y, nearestDef.x, nearestDef.y) < 6.5) {
                                        let pullX = (p.x > nearestDef.x) ? 1.8 : -1.8;
                                        let pullY = (p.y > nearestDef.y) ? 2.5 : -2.5; // Y축 횡이동 회피 기동 대폭 강화
                                        targetX = p.x + pullX * 5;
                                        targetY = p.y + pullY * 5;
                                        p.isMakingRun = true;
                                    } else {
                                        targetX = targetGoalX - (dir * 4); 
                                        // 스트라이커도 중앙에 가만히 서있지 않고 빈공간을 찾아 좌우로 스위칭
                                        targetY = 50 + (Math.random() - 0.5) * 25; 
                                        p.isMakingRun = true;
                                    }
                                    
                                    if (dir === 1 && targetX >= offsideLine) targetX = offsideLine - 1.0;
                                    if (dir === -1 && targetX <= offsideLine) targetX = offsideLine + 1.0;
                                } else {
                                    targetX = offsideLine - (dir * 2.0);
                                    targetY = p.baseY + (state.ball.y - p.baseY) * 0.2 + organicY;
                                }
                            }
                            
                            if (p.role !== 'GK' && p.role !== 'DF' && state.ball.x < offsideLine) {
                                if (dir === 1 && targetX >= offsideLine) targetX = offsideLine - 1.0;
                                if (dir === -1 && targetX <= offsideLine) targetX = offsideLine + 1.0;
                            }
                        }
                    }
                }

                // ★ 물리 태클 경합 엔진 (쿨다운 및 충돌반경 개선)
                state.players.forEach(other => {
                    if (other !== p && other.role !== 'GK') {
                        let dx = p.x - other.x; let dy = p.y - other.y;
                        let d = Math.sqrt(dx*dx + dy*dy) || 1;
                        
                        // 1. 경합 범위 대폭 축소: 2.0 -> 1.2 (선수들이 확실히 부딪혔을 때만 발생)
                        if (d < 1.2) { 
                            if (p.team === other.team) {
                                // 같은 팀끼리는 아주 부드럽게만 빗겨가도록 힘 축소
                                let repel = (1.2 - d) * 0.1;
                                targetX += (dx / d) * repel; targetY += (dy / d) * repel;
                            } else {
                                if (p.duelCooldown <= 0 && other.duelCooldown <= 0 && state.phase === 'play') {
                                    let pHasBall = (ballCarrier && ballCarrier.id === p.id);
                                    let otherHasBall = (ballCarrier && ballCarrier.id === other.id);

                                    // 상황 A: 누군가 공을 가지고 있을 때의 '태클 경합'
                                    if (pHasBall || otherHasBall) {
                                        // 2. 경합 시간(스턴) 심각하게 긴 문제 해결
                                        p.duelCooldown = 12; // 25 -> 12 (약 1.2초간 연속 태클 면역)
                                        other.duelCooldown = 12;
                                        p.cooldown = 4;      // 12 -> 4 (약 0.4초만 멈칫함)
                                        other.cooldown = 4;
                                        
                                        if (Math.random() < 0.25) {
                                            state.ball.vx = (Math.random() - 0.5) * 8; 
                                            state.ball.vy = (Math.random() - 0.5) * 8;
                                            state.eventText = "⚔️ 태클 성공!";
                                            state.possessionTeam = 0; 
                                            state.passTargetId = null; 
                                        }

                                        // 태클 후 튕겨나가는 거리도 축소
                                        targetX += (dx / d) * 1.5; targetY += (dy / d) * 1.5;
                                        
                                    // 상황 B: 둘 다 공이 없는 '루즈볼 달리기 경합' (프리징 현상 원인)
                                    } else {
                                        // 3. 서로 똑같이 밀어내는 대신, 스피드 스탯 기반으로 승패를 명확히 가름
                                        let pSpeed = (p.stats && p.stats.spd) ? p.stats.spd : 80;
                                        let oSpeed = (other.stats && other.stats.spd) ? other.stats.spd : 80;
                                        
                                        // 스탯에 약간의 주사위(난수)를 섞어 변수 창출
                                        let pScore = pSpeed + (Math.random() * 20);
                                        let oScore = oSpeed + (Math.random() * 20);

                                        if (pScore > oScore) {
                                            // p가 어깨싸움 승리: other만 0.2초 멈칫하게 만들고 p는 뚫고 지나감
                                            other.cooldown = 2; 
                                        } else {
                                            // other가 어깨싸움 승리: p가 0.2초 멈칫하고 살짝 튕겨남
                                            p.cooldown = 2;
                                            let repel = (1.2 - d) * 0.2;
                                            targetX += (dx / d) * repel; targetY += (dy / d) * repel;
                                        }
                                    }
                                }
                            }
                        }
                    }
                });

                targetX = isNaN(targetX) ? p.baseX : Math.max(2, Math.min(98, targetX)); 
                targetY = isNaN(targetY) ? p.baseY : Math.max(2, Math.min(98, targetY));
                
                let moveSpeed = ((p.stats && p.stats.spd ? p.stats.spd : 80) / 100) * 0.85; 
                if (isPressing || state.passTargetId === p.id || p.isMakingRun) moveSpeed *= 1.25; 
                
                let distToTarget = getDistance(p.x, p.y, targetX, targetY) || 1;
                if (distToTarget > moveSpeed) {
                    p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                    p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
                } else { p.x = targetX; p.y = targetY; }
            });

            // --- 5. 스마트 상황 판단 ---
            state.players.forEach(p => {
                let touchRadius = p.role === 'GK' ? 3.0 : 2.5; 
                let distToBallAct = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                let isBallInAir = (state.ball.airTicks && state.ball.airTicks > 0);
                let dir = (p.team === leftTeam) ? 1 : -1;
                let targetGoalX = (p.team === leftTeam) ? 100 : 0;

                if (!isBallInAir && distToBallAct < touchRadius && p.cooldown <= 0 && state.phase === 'play') {
                    state.lastTouchTeam = p.team;
                    state.passTargetId = null; 

                    if (state.isKickoff) {
                        if (p.team === state.kickoffTeam) {
                            let mates = state.players.filter(m => m.team === p.team && m.role !== 'GK' && m.id !== p.id);
                            let targetMate = mates[Math.floor(Math.random() * Math.min(3, mates.length))]; 
                            if (targetMate) {
                                let d = getDistance(p.x, p.y, targetMate.x, targetMate.y) || 1;
                                state.ball.vx = ((targetMate.x - p.x) / d) * 3.5; state.ball.vy = ((targetMate.y - p.y) / d) * 3.5;
                                state.passTargetId = targetMate.id; 
                                state.lastPasserId = p.id; 
                                io.to(roomCode).emit('playSound', 'kick'); 
                                p.cooldown = 12; 
                                state.isKickoff = false; 
                                return; 
                            }
                        }
                        state.isKickoff = false; 
                    }

                    if (p.role === 'GK') {
                        let isInBox = Math.abs(p.x - (p.team === leftTeam ? 0 : 100)) < 20 && p.y > 20 && p.y < 80;
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
                    if (distToGoal > 15) {
                        state.players.forEach(e => {
                            if (e.team !== p.team && e.role !== 'GK') {
                                if (getDistance(p.x, p.y, e.x, e.y) < 8 && 
                                    pDistance(e.x, e.y, p.x, p.y, targetGoalX, 50) < 2.5 && 
                                    ((dir===1 && e.x > p.x) || (dir===-1 && e.x < p.x))) shotBlocked = true;
                            }
                        });
                    }

                    // ★ 슈팅 난사 제한 로직
                    let maxShotDist = (p.stats && p.stats.sht && p.stats.sht >= 85) ? 30 : 22; 
                    
                    let isStrikerInBox = (p.role === 'FW' && distToGoal < 22);
                    let shootProb = isStrikerInBox ? 1.0 : (distToGoal > 20 ? ((p.stats.sht || 80) - 75) / 100 : 1.0); 

                    if (distToGoal < maxShotDist && !shotBlocked) {
                        if (Math.random() < shootProb) {
                            io.to(roomCode).emit('playSound', 'kick');
                            
                            // [핵심 개선 3] 무조건 유효슈팅/결정을 짓는 '대포알 슈팅' 파워 연산 (최소 8.5 보장, 스탯 비례 최대 12.0)
                            let power = 8.5 + (((p.stats && p.stats.sht ? p.stats.sht : 80) - 70) * 0.15);
                            
                            // [핵심 개선 3] 골키퍼 정면(50)이 아닌, 골대 완전 구석 사각지대(36~39 또는 61~64)로 날카롭게 조준
                            let aimY = (Math.random() < 0.5) ? (36 + Math.random() * 3) : (61 + Math.random() * 3);
                            
                            let dx = targetGoalX - p.x, dy = aimY - p.y; let d = Math.sqrt(dx*dx + dy*dy) || 1; 
                            state.ball.vx = (dx / d) * power; state.ball.vy = (dy / d) * power;
                            
                            // 슛 플래그 시간을 15틱으로 늘려, 공이 날아가는 동안 물리 엔진의 속도 저항을 무시하게 함
                            state.ball.shotTicks = 15; 
                            p.cooldown = 12; 
                            state.eventText = distToGoal > 24 ? "🚀 벼락같은 중거리 슛!" : "🔥 결정적 슈팅!";
                            return;
                        }
                    }

                    let inFinalThird = (p.team === leftTeam && state.ball.x > 65) || (p.team === rightTeam && state.ball.x < 35);
                    let inAttackingHalf = (p.team === leftTeam && state.ball.x > 50) || (p.team === rightTeam && state.ball.x < 50);
                    let inOwnHalf = (p.team === leftTeam && state.ball.x <= 50) || (p.team === rightTeam && state.ball.x >= 50);
                    let isPressed = state.players.some(e => e.team !== p.team && getDistance(p.x, p.y, e.x, e.y) < 12);

                    let passOptions = [];
                    state.players.forEach(m => {
                        if (m.team === p.team && m.id !== p.id && m.role !== 'GK') {
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            if (dist < 8 || dist > 40) return; 

                            let forwardDist = (p.team === leftTeam) ? (m.x - p.x) : (p.x - m.x); 
                            let laneBlocked = false;
                            let minEnemyDistToM = Infinity;
                            
                            state.players.forEach(e => {
                                if (e.team !== p.team && e.role !== 'GK') {
                                    if (pDistance(e.x, e.y, p.x, p.y, m.x, m.y) < 3.5) laneBlocked = true;
                                    let d2 = getDistance(m.x, m.y, e.x, e.y);
                                    if (d2 < minEnemyDistToM) minEnemyDistToM = d2;
                                }
                            });

                            let score = 0; 
                            let isThrough = false;
                            
                            if (laneBlocked) score -= 2000; 

                            // [핵심 개선] 백패스 혐오 로직 (롱 백패스 및 공격수 백패스 절대 금지)
                            if (forwardDist < -2) {
                                // 1. 뒤로 주는 패스인데 거리가 15 이상 멀다? 절대 안 함
                                if (dist > 15) score -= 5000; 
                                // 2. 최전방 공격수(FW)가 공격 진영에서 뜬금없이 뒤로 돌리는 행위 원천 차단
                                if (p.role === 'FW' && inAttackingHalf) score -= 5000;
                            }

                            if (inAttackingHalf) score += (forwardDist * 7.5); 
                            else score += (forwardDist * 4.5); 

                            if (inOwnHalf && isPressed && forwardDist > 10 && !laneBlocked) {
                                score += 800; isThrough = true; 
                            }

                            score -= (dist * 0.85); 
                            score += (minEnemyDistToM * 4); 

                            if (state.lastPasserId === m.id) score -= 1500; 
                            score += (Math.random() * 40);

                            if (m.isMakingRun && forwardDist > 0 && minEnemyDistToM > 5 && !laneBlocked) {
                                score += inAttackingHalf ? 850 : 650; isThrough = true;
                            }
                            if (inFinalThird && m.isMakingRun && forwardDist < 0 && forwardDist > -15 && !laneBlocked) {
                                score += 750; isThrough = true;
                            }

                            if (score > 0) passOptions.push({ mate: m, score: score, dist: dist, isThrough: isThrough });
                        }
                    });

                    passOptions.sort((a, b) => b.score - a.score);
                    let bestOption = passOptions.length > 0 ? passOptions[0] : null;

                    let ballSpeedSq = state.ball.vx ** 2 + state.ball.vy ** 2;
                    
                    // [핵심 개선 1: 완벽한 퍼스트 터치]
                    // 공이 빠르게 날아올 때, 튕겨나가지 않도록 완벽하게 속도를 죽이고 선수의 이동 방향(몸 앞)에 살짝 잡아놓음
                    if (ballSpeedSq > 10) { 
                        state.ball.vx = 0; 
                        state.ball.vy = 0; 
                        state.ball.x = p.x + (dir * 0.3); // 몸 앞쪽으로 예쁘게 잡아놓기
                        state.ball.y = p.y; 
                        
                        // 쿨다운(경직)을 1에서 0으로 아예 없애버림. 터치하자마자 곧바로 다음 드리블이나 패스를 이어감
                        p.cooldown = 0; 
                        state.eventText = "볼 컨트롤";
                        return; 
                    }

                    let wantsToHold = (p.role === 'FW' && inAttackingHalf);
                    let passThreshold = wantsToHold ? (bestOption && bestOption.isThrough ? 25 : 65) : 25;

                    if (bestOption && bestOption.score > passThreshold) {
                        let errorMargin = 0.4; 
                        let targetX = bestOption.mate.x + (Math.random() - 0.5) * errorMargin; 
                        let targetY = bestOption.mate.y + (Math.random() - 0.5) * errorMargin;
                        
                        let isBackpass = (p.team === leftTeam) ? (targetX < p.x) : (targetX > p.x);

                        if (isBackpass) {
                            targetX = bestOption.mate.x; targetY = bestOption.mate.y; bestOption.isThrough = false;
                        } else if (bestOption.isThrough) {
                            targetX += dir * 4.5; 
                        }

                        io.to(roomCode).emit('playSound', 'kick');
                        
                        let d = getDistance(p.x, p.y, targetX, targetY) || 1; 
                        let powerDivider = bestOption.isThrough ? 5.5 : 4.5;
                        let power = Math.max(2.5, Math.min(d / powerDivider, 5.0)); 

                        state.ball.vx = ((targetX - p.x) / d) * power;
                        state.ball.vy = ((targetY - p.y) / d) * power; 
                        
                        if (d > 20) {
                            state.ball.airTicks = Math.floor(d / 5.0);
                            state.eventText = bestOption.isThrough ? "🎯 정교한 스루패스!" : "🚀 롱 패스 전환!";
                        } else {
                            state.eventText = bestOption.isThrough ? "창의적 스루패스!" : "연계 플레이";
                        }
                        
                        state.passTargetId = bestOption.mate.id; state.lastPasserId = p.id; p.cooldown = 8; 
                    } 
                    else {
                        let pSpeed = ((p.stats && p.stats.spd ? p.stats.spd : 80) / 100);
                        let nearestEnemy = state.players.find(e => e.team !== p.team && getDistance(e.x, e.y, p.x, p.y) < 8);
                        
                        if (nearestEnemy) {
                            let inDefensiveThird = (p.team === leftTeam && state.ball.x < 35) || (p.team === rightTeam && state.ball.x > 65);
                            let dx = p.x - nearestEnemy.x; let dy = p.y - nearestEnemy.y; let dist = Math.sqrt(dx*dx + dy*dy) || 1;
                            let enemyInFront = (dir === 1 && nearestEnemy.x > p.x) || (dir === -1 && nearestEnemy.x < p.x);
                            
                            if (inDefensiveThird && dist < 5 && (!bestOption || bestOption.score < 20)) {
                                state.ball.vx = dir * 6.5; state.ball.vy = (Math.random() - 0.5) * 5.0; 
                                state.ball.airTicks = 4; state.eventText = "💥 전방 걷어내기!"; p.cooldown = 6; 
                            } else {
                                let evadeX = dx / dist; let evadeY = dy / dist;
                                
                                if (enemyInFront) {
                                    let sideDir = (p.y > 50) ? -1 : 1; 
                                    if (Math.abs(p.y - 50) < 5) sideDir = Math.random() < 0.5 ? -1 : 1;
                                    
                                    // [핵심 개선 2: 이동 컨트롤 타이트하게]
                                    // 공을 옆으로 칠 때(측면 돌파) 공이 튕겨나가는 강도를 3.0에서 1.2로 확 줄임
                                    state.ball.vx = (evadeX * 0.2) + (dir * 0.4); 
                                    state.ball.vy = (sideDir * 1.2); 
                                    state.eventText = wantsToHold ? "🛡️ 등지기 (키핑)" : "⚡ 짧은 측면 터치!";
                                } else {
                                    // 앞으로 밀고 나갈 때도 강도를 1.8 -> 1.0으로 낮춰 발밑에 밀착시킴
                                    state.ball.vx = (evadeX * 0.6) + (dir * 1.0); 
                                    state.ball.vy = evadeY * 0.6; 
                                    state.eventText = wantsToHold ? "🛡️ 볼 지키기" : "⚡ 전진 탈압박!";
                                }
                                // 드리블 후 경직 시간을 2에서 1로 줄여 선수가 즉시 공에 따라붙도록 함
                                p.cooldown = 1; 
                            }
                        } else {
                            let centerDriveVy = (50 - p.y) * 0.05 + (Math.random() - 0.5);
                            if (inFinalThird && Math.random() < 0.3) {
                                // [핵심 개선 3: 치달 안정화] 빈 공간으로 길게 칠 때도 너무 멀리 나가지 않게 하향
                                state.ball.vx = dir * pSpeed * 1.6; 
                                state.ball.vy = centerDriveVy * 0.8; 
                                state.eventText = "⚡ 공간 돌파!"; 
                                // 경직 시간 4 -> 2
                                p.cooldown = 2; 
                            } else {
                                // 기본 전진 드리블 시 발끝에 완전히 붙이도록 스피드 하향
                                state.ball.vx = dir * pSpeed * 0.9; 
                                state.ball.vy = centerDriveVy * 0.4; 
                                state.eventText = wantsToHold ? "🛡️ 볼 키핑" : "전진 드리블"; 
                                // 경직 시간 2 -> 1
                                p.cooldown = 1; 
                            }
                        }
                    }
                }
            });

            // --- 6. 아웃 및 골 판정 ---
            if (state.phase === 'play') {
                if (state.ball.x <= 0) {
                    if (state.ball.y > 38 && state.ball.y < 62) handleGoal(room, rightTeam); 
                    else setupSetPiece(state, state.lastTouchTeam === leftTeam ? 'corner' : 'goal_kick', leftTeam);
                } 
                else if (state.ball.x >= 100) {
                    if (state.ball.y > 38 && state.ball.y < 62) handleGoal(room, leftTeam); 
                    else setupSetPiece(state, state.lastTouchTeam === rightTeam ? 'corner' : 'goal_kick', rightTeam);
                } 
                else if (state.ball.y <= 0 || state.ball.y >= 100) {
                    setupSetPiece(state, 'throw_in', state.lastTouchTeam === leftTeam ? rightTeam : leftTeam);
                }
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
    setTimeout(() => { 
        if(room.matchState) { 
            resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1); 
            io.to(room.code).emit('playSound', 'whistle'); 
        } 
    }, 3000);
}

function setupSetPiece(state, type, sideTeam = 1) {
    state.phase = type; state.setPieceTimer = 20; state.ball.vx = 0; state.ball.vy = 0;
    
    // 세트피스 대응 진영
    let leftTeam = state.half === 1 ? 1 : 2;
    let rightTeam = state.half === 1 ? 2 : 1;
    let dir = sideTeam === leftTeam ? 1 : -1;

    if (type === 'throw_in') {
        state.eventText = "스로인"; state.ball.y = state.ball.y <= 0 ? 2 : 98;
        state.ball.x = Math.max(5, Math.min(95, state.ball.x)); 
        let fieldPlayers = state.players.filter(p => p.role !== 'GK');
        let thrower = fieldPlayers
            .filter(p => p.team === sideTeam)
            .reduce((prev, curr) => (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev));
        
        state.throwerId = thrower.id; state.possessionTeam = thrower.team;
        thrower.x = state.ball.x; thrower.y = state.ball.y; thrower.cooldown = 20;
    } 
    else if (type === 'corner') {
        state.eventText = "코너킥"; state.possessionTeam = sideTeam === leftTeam ? rightTeam : leftTeam;
        let attTeam = state.possessionTeam;
        let goalX = sideTeam === leftTeam ? 2 : 98; state.ball.x = goalX; state.ball.y = (state.ball.y > 50) ? 98 : 2;
        
        let kicker = state.players.find(p => p.team === attTeam && p.role === 'FW') || state.players.find(p => p.team === attTeam && p.role !== 'GK');
        if(kicker) { 
            kicker.x = state.ball.x; 
            kicker.y = state.ball.y; 
            kicker.cooldown = 20; 
            state.kickerId = kicker.id; 
        }
    }
    else if (type === 'goal_kick') {
        state.eventText = "골킥"; state.possessionTeam = sideTeam;
        let goalX = sideTeam === leftTeam ? 5 : 95; state.ball.x = goalX; state.ball.y = 50;
        
        let gk = state.players.find(p => p.team === sideTeam && p.role === 'GK');
        if(gk) { gk.x = state.ball.x; gk.y = state.ball.y; gk.cooldown = 0; } 
    }
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
    setTimeout(() => { startMatchPhase(roomCode, true); }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
