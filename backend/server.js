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
        if(!room) return;
        room.players[socket.id].team.push({ slot: slotId, player: playerInfo });
        room.currentDraft.answers++;
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
    room.currentDraft = { p1: p1Player, p2: p2Player, answers: 0 };
    io.to(roomCode).emit('draftPlayer', { p1: p1Player, p2: p2Player, timeLimit: room.settings.timer });
    room.draftTimeout = setTimeout(() => { io.to(roomCode).emit('forceRandomPlacement'); }, room.settings.timer * 1000);
}

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode];
    room.state = 'match'; room.code = roomCode; 
    
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]], p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions, p2Formation = db.formations[p2Data.formation].positions;
        const gkStats = { spd: 82, sht: 85, pas: 80 };

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

    io.to(roomCode).emit('matchStarted', room.matchState);
    io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        if (state.isPaused) return; 
        state.ticks++;

        // --- ★ 골키퍼 캐치 & 세트피스 로직 ---
        if (state.phase !== 'play') {
            state.setPieceTimer--;
            if (state.setPieceTimer <= 0) {
                io.to(roomCode).emit('playSound', 'kick');
                
                if (state.phase === 'gk_hold' && state.gkHolder) {
                    let p = state.gkHolder;
                    let dir = (p.team === 1) ? 1 : -1;
                    // 골키퍼가 공을 잡았다가 사이드쪽으로 크게 걷어냄
                    state.ball.vx = dir * 6.0; 
                    state.ball.vy = (p.y > 50) ? 3.5 : -3.5; 
                    p.cooldown = 10;
                } else {
                    let dir = (state.possessionTeam === 1) ? 1 : -1;
                    if (state.phase === 'throw_in') {
                        let mates = state.players.filter(p => p.team === state.possessionTeam && p.id !== state.throwerId && p.role !== 'GK');
                        mates.sort((a,b) => getDistance(state.ball.x, state.ball.y, a.x, a.y) - getDistance(state.ball.x, state.ball.y, b.x, b.y));
                        let target = mates[0];
                        if(target) {
                            let dist = getDistance(state.ball.x, state.ball.y, target.x, target.y);
                            state.ball.vx = ((target.x - state.ball.x) / dist) * 2.5;
                            state.ball.vy = ((target.y - state.ball.y) / dist) * 2.5;
                        } else {
                            state.ball.vx = dir * 2.0; state.ball.vy = 0;
                        }
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
            emitUpdate(roomCode, state);
            return;
        }

        // --- 1. 물리 연산 ---
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

        // --- 2. 랭킹 기반 소유권 & 압박 리스트 계산 ---
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

        // --- 3. 체계적 지역방어 & 랭크 압박 AI ---
        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let ownGoalX = (p.team === 1) ? 0 : 100;
            let targetGoalX = (p.team === 1) ? 100 : 0;

            // ★ 내 팀 내에서의 공과의 거리 랭킹 파악 (압박 인원 제한용)
            let myDistArr = (p.team === 1) ? distArr1 : distArr2;
            let rankObj = myDistArr.find(obj => obj.p === p);
            let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
            let distToBall = rankObj ? rankObj.dist : 999;

            let isPressing = false;
            if (p.role !== 'GK') {
                if (rank === 0) isPressing = true; // 1등은 무조건 압박
                else if (rank === 1 && distToBall < 15) isPressing = true; // 2등은 가까울때만 협력수비
                else if (rank === 2 && distToBall < 8) isPressing = true; // 3등은 극히 위험할때만
            }

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 3);
                targetY = Math.max(40, Math.min(60, state.ball.y)); 
                if(distToBall < 15) { targetX = state.ball.x; targetY = state.ball.y; }
            } 
            else if (isPressing) {
                targetX = state.ball.x; targetY = state.ball.y; 
            } 
            else if (attTeam === p.team) {
                if (p.role === 'DF') {
                    targetX = Math.max(20, Math.min(80, state.ball.x - (dir * 15)));
                    targetY = p.baseY; 
                } else if (p.role === 'MF') {
                    targetX = Math.max(30, Math.min(70, state.ball.x + (dir * 10)));
                    targetY = p.baseY; 
                } else if (p.role === 'FW') {
                    targetX = (p.team === 1) ? 85 : 15; 
                    targetY = p.baseY; 
                }
            } 
            else {
                if (p.role === 'DF') { targetX = ownGoalX + (dir * 15); targetY = p.baseY; } 
                else if (p.role === 'MF') { targetX = state.ball.x - (dir * 10); targetY = p.baseY; } 
                else if (p.role === 'FW') { targetX = state.ball.x + (dir * 5); targetY = p.baseY; }
            }

            targetX = Math.max(3, Math.min(97, targetX));
            targetY = Math.max(3, Math.min(97, targetY));

            let moveSpeed = (p.stats.spd || 80) / 100; 
            if (isPressing) moveSpeed *= 1.25; // 압박 시 순간 속도 증가
            
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 4. 터치 및 볼 플레이 (캐치, 빈 공간 드리블) ---
            if (distToBall < 3 && p.cooldown === 0) { 
                state.lastTouchTeam = p.team;
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                if (p.role === 'GK') {
                    let isInBox = Math.abs(p.x - ownGoalX) < 18 && p.y > 20 && p.y < 80;
                    if (isInBox) {
                        // ★ 골키퍼 캐치 시스템
                        state.phase = 'gk_hold';
                        state.gkHolder = p;
                        state.setPieceTimer = 15; // 1.5초간 안고있음
                        state.ball.vx = 0; state.ball.vy = 0;
                        state.ball.x = p.x; state.ball.y = p.y;
                        state.eventText = "키퍼 캐치";
                        p.cooldown = 20;
                    } else {
                        io.to(roomCode).emit('playSound', 'kick');
                        state.ball.vx = dir * 6.0; state.ball.vy = (p.y > 50) ? 3.0 : -3.0;
                        p.cooldown = 15;
                    }
                } 
                else if (distToGoal < 28) {
                    io.to(roomCode).emit('playSound', 'kick');
                    let power = (p.stats.sht || 85) / 15; 
                    state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                    state.ball.vy = ((50 - p.y) / distToGoal) * power;
                    p.cooldown = 10;
                } 
                else {
                    let bestMate = null; let maxScore = -999;
                    state.players.forEach(m => {
                        if (m.team === p.team && m !== p && m.role !== 'GK') {
                            let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x); 
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            let score = (forwardDist * 5) - dist; 
                            
                            let enemyNear = false;
                            state.players.forEach(e => {
                                if (e.team !== p.team && getDistance(m.x, m.y, e.x, e.y) < 8) enemyNear = true;
                            });
                            if (enemyNear) score -= 100;
                            if (dist < 8 || dist > 50) score -= 100; 

                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    // 주변 적의 압박 강도
                    let nearestEnemy = null; let minE = Infinity;
                    state.players.forEach(e => {
                        if (e.team !== p.team && e.role !== 'GK') {
                            let d = getDistance(p.x, p.y, e.x, e.y);
                            if (d < minE) { minE = d; nearestEnemy = e; }
                        }
                    });

                    if (bestMate && maxScore > -10 && minE < 12) {
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = (p.stats.pas || 80) / 20; 
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                        state.ball.vx = ((bestMate.x - p.x) / d) * power;
                        state.ball.vy = ((bestMate.y - p.y) / d) * power;
                        p.cooldown = 10; 
                    } else {
                        // ★ 빈 공간으로 목적성 있는 드리블
                        let isFinalThird = (p.team === 1 && p.x > 66) || (p.team === 2 && p.x < 34);
                        if (isFinalThird) {
                            // 파이널 서드에서는 박스(골대 중앙)를 향해 파고들기
                            let dGoal = getDistance(p.x, p.y, targetGoalX, 50);
                            state.ball.vx = ((targetGoalX - p.x) / dGoal) * 1.6;
                            state.ball.vy = ((50 - p.y) / dGoal) * 1.6;
                        } else {
                            // 그 외 지역은 빈 공간(적의 반대쪽 대각선)으로 전진
                            let vyDir = (p.y > 50) ? -1 : 1;
                            if (nearestEnemy) vyDir = (p.y > nearestEnemy.y) ? 1 : -1; 
                            
                            state.ball.vx = dir * 1.6;
                            state.ball.vy = vyDir * 1.2;
                        }
                        p.cooldown = 4; 
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
