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
    state.players.forEach(p => { 
        p.x = p.baseX; p.y = p.baseY; 
        p.cooldown = 0; // 공 터치 쿨타임 초기화
    });
    const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW');
    if (striker) { striker.x = 50; striker.y = 51; }
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
        const gkStats = { spd: 82, sht: 85, pas: 75 };

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, isPaused: false, possessionTeam: 1,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => {
                    const pos = p1Formation[t.slot];
                    return { ...t.player, team: 1, role: getRole(pos.id), posId: pos.id, slotIdx: idx, x: pos.x / 2, y: pos.y, baseX: pos.x / 2, baseY: pos.y, cooldown: 0 };
                }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats, cooldown: 0 },
                ...p2Data.team.map((t, idx) => {
                    const pos = p2Formation[t.slot];
                    return { ...t.player, team: 2, role: getRole(pos.id), posId: pos.id, slotIdx: idx, x: 100 - (pos.x / 2), y: 100 - pos.y, baseX: 100 - (pos.x / 2), baseY: 100 - pos.y, cooldown: 0 };
                }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', posId:'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats, cooldown: 0 }
            ]
        };
    } else {
        room.matchState.half = 2; room.matchState.ticks = 0; room.matchState.isPaused = false;
        resetPositions(room.matchState, 2);
    }

    io.to(roomCode).emit('matchStarted', room.matchState);
    io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        if (state.isPaused) return; 
        state.ticks++;

        // 1. 공 물리 연산 (마찰력 증가로 속도 제어)
        state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
        state.ball.vx *= 0.88; state.ball.vy *= 0.88;
        if (state.ball.y <= 2 || state.ball.y >= 98) state.ball.vy *= -1; 
        
        // 득점 판정
        if (state.ball.x <= 1.5) {
            if (state.ball.y >= 38 && state.ball.y <= 62) handleGoal(room, 2); 
            else { state.ball.vx *= -1; state.ball.x = 2; }
        } else if (state.ball.x >= 98.5) {
            if (state.ball.y >= 38 && state.ball.y <= 62) handleGoal(room, 1); 
            else { state.ball.vx *= -1; state.ball.x = 98; }
        }
        if (state.isPaused) return; 

        // 2. 가장 가까운 선수 파악 (소유권)
        let minDist1 = Infinity, minDist2 = Infinity;
        let closest1 = null, closest2 = null;
        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
            if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
        });

        // 3. 체계적인 AI 이동 로직 (뭉침 방지 및 대형 유지)
        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;

            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let ownGoalX = (p.team === 1) ? 0 : 100;

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 2);
                targetY = Math.max(40, Math.min(60, state.ball.y));
                if(getDistance(p.x, p.y, state.ball.x, state.ball.y) < 15) { targetX = state.ball.x; targetY = state.ball.y; }
            } 
            else if (p === closest1 || p === closest2) {
                // 각 팀에서 공과 가장 가까운 단 1명만 공을 향해 달림 (압박/수비)
                targetX = state.ball.x; targetY = state.ball.y; 
            } 
            else {
                // 나머지 선수들은 자기 포메이션 자리(Grid)를 철저히 지키며 라인만 이동
                let isAttacking = (p.team === 1 && state.ball.x > 50) || (p.team === 2 && state.ball.x < 50);
                
                if (isAttacking) {
                    // 공격 시 공간 창출 (좌우로 넓게)
                    targetX = p.baseX + (dir * 15);
                    targetY = p.baseY + ((state.ball.y - 50) * 0.2); // 공 따라 살짝만 이동 (뭉침 방지)
                    if (p.role === 'FW') targetX += (dir * 15); // 공격수 침투
                } else {
                    // 수비 시 두줄 수비 (간격 좁히기)
                    targetX = p.baseX - (dir * 10);
                    targetY = p.baseY + ((state.ball.y - 50) * 0.4);
                }

                // ★ 선수끼리 겹침 방지 (Repulsion)
                state.players.forEach(mate => {
                    if (mate !== p && mate.team === p.team && mate.role !== 'GK') {
                        if (getDistance(p.x, p.y, mate.x, mate.y) < 6) {
                            targetX += (p.x - mate.x) * 0.5;
                            targetY += (p.y - mate.y) * 0.5;
                        }
                    }
                });
            }

            // 속도 대폭 하향 (템포 조절)
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            let moveSpeed = (p.stats.spd || 75) / 130; // 기존 60에서 130으로 나누어 속도 절반 감소
            if (p === closest1 || p === closest2) moveSpeed *= 1.2; // 공 쫓을 땐 약간 빠르게

            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // 4. 터치 및 볼 플레잉 로직 (드리블 최우선, 패스는 안전할 때만)
            let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (distToBall < 3 && p.cooldown === 0) { 
                
                let targetGoalX = (p.team === 1) ? 100 : 0;
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                // 적의 압박 강도 체크 (내 주변 10 반경 안의 적)
                let enemyNearDist = Infinity;
                state.players.forEach(e => {
                    if (e.team !== p.team) {
                        let d = getDistance(p.x, p.y, e.x, e.y);
                        if (d < enemyNearDist) enemyNearDist = d;
                    }
                });

                if (p.role === 'GK') {
                    // 키퍼는 잡으면 무조건 멀리 롱킥 클리어링 (안전 제일)
                    io.to(roomCode).emit('playSound', 'kick');
                    state.ball.vx = dir * 6.0; 
                    state.ball.vy = (Math.random() - 0.5) * 3;
                    p.cooldown = 15;
                } 
                else if (distToGoal < 25) {
                    // 완벽한 슛 찬스
                    io.to(roomCode).emit('playSound', 'kick');
                    let power = (p.stats.sht || 80) / 15; 
                    state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                    state.ball.vy = ((50 - p.y) / distToGoal) * power;
                    p.cooldown = 10;
                } 
                else if (enemyNearDist < 8) {
                    // ★ 적이 바짝 붙었을 때만 패스 시도 (패스 미스 방지)
                    let bestMate = null; let maxSafety = -999;
                    
                    state.players.forEach(m => {
                        if (m.team === p.team && m !== p && m.role !== 'GK') {
                            // 동료 주변의 적 거리 체크
                            let mateEnemyDist = Infinity;
                            state.players.forEach(e => {
                                if (e.team !== p.team) {
                                    let d = getDistance(m.x, m.y, e.x, e.y);
                                    if (d < mateEnemyDist) mateEnemyDist = d;
                                }
                            });
                            // 앞쪽으로 주되, 동료가 널널한(압박 없는) 상태일수록 점수 높음
                            let forwardBias = (p.team === 1) ? (m.x - p.x) : (p.x - m.x);
                            let score = (mateEnemyDist * 2) + (forwardBias * 0.5) - getDistance(p.x, p.y, m.x, m.y)*0.2;
                            if (score > maxSafety) { maxSafety = score; bestMate = m; }
                        }
                    });

                    if (bestMate && maxSafety > 10) {
                        // 안전한 동료 발밑으로 정확하게 패스 (오차 제거)
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = (p.stats.pas || 80) / 20;
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                        state.ball.vx = ((bestMate.x - p.x) / d) * power;
                        state.ball.vy = ((bestMate.y - p.y) / d) * power;
                        p.cooldown = 10; // 패스 후 1초간 공 못 만짐
                    } else {
                        // 줄 곳 없으면 걷어내기
                        io.to(roomCode).emit('playSound', 'kick');
                        state.ball.vx = dir * 4.0;
                        state.ball.vy = (Math.random() - 0.5) * 3;
                        p.cooldown = 10;
                    }
                } 
                else {
                    // ★ 적이 멀리 있으면 여유롭게 공간으로 드리블
                    // 공을 앞쪽 빈 공간으로 톡톡 치고 달림
                    state.ball.vx = dir * 1.5;
                    state.ball.vy = ((50 - p.y) * 0.02); // 중앙으로 살짝 좁히며 드리블
                    p.cooldown = 4; // 짧은 쿨타임 후 다시 터치
                }
            }
        });

        let totalTicks = state.ticks;
        let gameSeconds = (totalTicks / 10) * (db.settings.gameMinutesPerHalf * 60 / db.settings.halfDurationRealSeconds);
        if (state.half === 2) gameSeconds += 45 * 60; 

        io.to(roomCode).emit('matchUpdate', {
            gameSeconds: gameSeconds, event: "오픈 플레이", ball: state.ball, players: state.players, score: state.score
        });

        if ((totalTicks / 10) >= db.settings.halfDurationRealSeconds) {
            clearInterval(room.matchInterval);
            io.to(roomCode).emit('playSound', 'whistle'); 
            if (state.half === 1) startHalfTime(roomCode);
            else io.to(roomCode).emit('matchEnded', state.score); 
        }
    }, 100); 
}

function handleGoal(room, scoringTeam) {
    room.matchState.isPaused = true;
    room.matchState.ball.x = 50; room.matchState.ball.y = 50;
    room.matchState.ball.vx = 0; room.matchState.ball.vy = 0;
    room.matchState.score[`team${scoringTeam}`]++;
    io.to(room.code).emit('playSound', 'whistle');
    io.to(room.code).emit('goalScored', { team: scoringTeam, score: room.matchState.score });
    
    setTimeout(() => {
        resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1);
        io.to(room.code).emit('playSound', 'whistle'); 
        room.matchState.isPaused = false;
    }, 3000);
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
    setTimeout(() => { startMatchPhase(roomCode, true); }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
