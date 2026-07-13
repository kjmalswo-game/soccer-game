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
// 특정 선수 주변의 상대편 숫자 계산 (압박 강도 파악용)
function countEnemiesNear(player, players, radius = 15) {
    return players.filter(p => p.team !== player.team && getDistance(p.x, p.y, player.x, player.y) < radius).length;
}

function resetPositions(state, kickoffTeam) {
    state.ball = { x: 50, y: 50, vx: 0, vy: 0 };
    state.players.forEach(p => { p.x = p.baseX; p.y = p.baseY; });
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
        if (playersArr.every(p => p.ready) && playersArr.length === 2) startDraftPhase(roomCode);
    });

    socket.on('playerPlaced', (roomCode, slotId, playerInfo) => {
        const room = rooms[roomCode];
        if(!room) return;
        room.players[socket.id].team.push({ slot: slotId, player: playerInfo });
        room.currentDraft.answers++;
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
                    return { ...t.player, team: 1, role: getRole(pos.id), posId: pos.id, slotIdx: idx, x: pos.x / 2, y: pos.y, baseX: pos.x / 2, baseY: pos.y };
                }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats },
                ...p2Data.team.map((t, idx) => {
                    const pos = p2Formation[t.slot];
                    return { ...t.player, team: 2, role: getRole(pos.id), posId: pos.id, slotIdx: idx, x: 100 - (pos.x / 2), y: 100 - pos.y, baseX: 100 - (pos.x / 2), baseY: 100 - pos.y };
                }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', posId:'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats }
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

        // 1. 공 물리 연산
        state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
        state.ball.vx *= 0.85; state.ball.vy *= 0.85; // 공 마찰력 약간 증가(빌드업 안정성)
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

        // 2. 소유권 파악
        let minDist1 = Infinity, minDist2 = Infinity;
        let closest1 = null, closest2 = null;
        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
            if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
        });

        if(minDist1 < minDist2 && minDist1 < 12) state.possessionTeam = 1;
        else if(minDist2 <= minDist1 && minDist2 < 12) state.possessionTeam = 2;
        const attTeam = state.possessionTeam;

        // ★ 모멘텀 (지고 있는 팀에게 미세한 투지 부여 -> 변수 창출)
        const goalDiff = state.score.team1 - state.score.team2;

        // 3. AI 오프더볼 및 수비 압박 이동 연산
        state.players.forEach(p => {
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let targetGoalX = (p.team === 1) ? 100 : 0;
            let ownGoalX = (p.team === 1) ? 0 : 100;

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 2);
                targetY = Math.max(38, Math.min(62, state.ball.y));
                if(getDistance(p.x, p.y, state.ball.x, state.ball.y) < 12) { targetX = state.ball.x; targetY = state.ball.y; }
            } 
            else if (p === closest1 || p === closest2) {
                targetX = state.ball.x; targetY = state.ball.y; 
            } 
            else if (attTeam === p.team) {
                // [공격 시 오프더볼 움직임]
                if (p.role === 'DF') {
                    if (p.posId.includes('L') || p.posId.includes('R') || p.posId === 'RB' || p.posId === 'LB') {
                        // 오버래핑
                        targetX = Math.min(85, Math.max(15, state.ball.x + (dir * 25)));
                        targetY = p.baseY; 
                    } else {
                        // U자 빌드업 지원 (공을 받기 위해 다가감)
                        targetX = state.ball.x - (dir * 15);
                        targetY = p.baseY + ((state.ball.y > 50) ? -15 : 15);
                    }
                } 
                else if (p.role === 'MF') {
                    // 빈 공간 찾아 들어가기 및 스위칭
                    targetX = state.ball.x + (dir * 10) + (Math.random()-0.5)*8;
                    targetY = state.ball.y + (p.baseY > 50 ? -15 : 15); // 빈 곳으로 이동
                } 
                else if (p.role === 'FW') {
                    // 적극적 뒷공간 침투 런
                    targetX = Math.max(5, Math.min(95, targetGoalX - (dir * 8) + (Math.random()-0.5)*10));
                    targetY = p.baseY + (Math.random()-0.5)*15;
                }
            } 
            else {
                // [수비 시 전방 압박 및 대형 유지]
                if (p.role === 'FW') {
                    // ★ 전방 압박 (상대 수비 진영에서 공을 향해 에워쌈)
                    targetX = state.ball.x + (dir * 5); 
                    targetY = state.ball.y + (Math.random() - 0.5) * 10;
                }
                else if (p.role === 'MF') {
                    // 미드필더진 강한 압박
                    targetX = state.ball.x - (dir * 10);
                    targetY = state.ball.y + (p.baseY > 50 ? 5 : -5);
                }
                else if (p.role === 'DF') {
                    // 수비 라인은 지역 방어 유지하며 좁히기
                    targetX = Math.max(10, Math.min(90, ownGoalX + (dir * 18)));
                    targetY = p.baseY + ((state.ball.y - 50) * 0.4);
                }
            }

            let momentumBuff = 0;
            if (p.team === 1 && goalDiff < 0) momentumBuff = 0.05; // 지고 있으면 이속 증가
            if (p.team === 2 && goalDiff > 0) momentumBuff = 0.05;
            
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            let moveSpeed = ((p.stats.spd || 75) / 60) * (1 + momentumBuff + (Math.random()*0.1)); // 랜덤 오차로 변수 창출
            if (p === closest1 || p === closest2) moveSpeed *= 1.2; 
            if (p.role === 'GK') moveSpeed *= 1.2; 

            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // 4. 터치 및 스마트 패스/슈팅 로직
            let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (distToBall < 2.5) { 
                io.to(roomCode).emit('playSound', 'kick');
                let targetGoalX = (p.team === 1) ? 100 : 0;
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                if (p.role === 'GK') {
                    // ★ 골키퍼 스마트 패스 (주변에 압박 없는 풀백/센터백 찾기)
                    let safeMates = state.players.filter(m => m.team === p.team && m.role !== 'GK' && countEnemiesNear(m, state.players, 20) === 0);
                    if(safeMates.length > 0 && Math.random() < 0.7) {
                        let target = safeMates[Math.floor(Math.random() * safeMates.length)];
                        let power = (p.stats.pas || 75) / 18;
                        let dist = getDistance(p.x, p.y, target.x, target.y);
                        state.ball.vx = ((target.x - p.x) / dist) * power;
                        state.ball.vy = ((target.y - p.y) / dist) * power;
                    } else {
                        // 없으면 전방 롱킥
                        state.ball.vx = dir * 5.0; 
                        state.ball.vy = (Math.random() - 0.5) * 4;
                    }
                } 
                else if (distToGoal < 30) {
                    // 슈팅
                    let power = (p.stats.sht || 80) / 13; 
                    state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                    state.ball.vy = ((50 - p.y) / distToGoal) * power + (Math.random()-0.5)*0.5;
                } 
                else {
                    // ★ 스마트 빌드업 패스 (압박이 적은 곳으로)
                    let mates = state.players.filter(m => m.team === p.team && m !== p && m.role !== 'GK');
                    let bestMate = null; let maxScore = -9999;
                    
                    mates.forEach(m => {
                        let enemiesNear = countEnemiesNear(m, state.players, 15);
                        let forwardDist = (p.team === 1) ? m.x - p.x : p.x - m.x; // 앞으로 갈수록 가점
                        let dist = getDistance(p.x, p.y, m.x, m.y);
                        // 평가 공식: 빈공간(적 없음) 가중치 대폭 증가, 너무 멀면 감점
                        let score = (forwardDist * 1.5) - (enemiesNear * 40) - (dist * 0.5) + (Math.random() * 15);
                        
                        // 사이드 공격 전개 가중치
                        if (Math.abs(m.y - 50) > 30) score += 10;

                        if(score > maxScore) { maxScore = score; bestMate = m; }
                    });

                    if (bestMate && maxScore > -40) { // 압박이 극심하지 않다면 패스
                        let power = (p.stats.pas || 80) / 20;
                        let dist = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                        // 스탯 기반 패스 삑사리(오차) 추가
                        let error = (Math.random() - 0.5) * (100 - p.stats.pas) * 0.15;
                        state.ball.vx = ((bestMate.x - p.x) / dist) * power;
                        state.ball.vy = ((bestMate.y + error - p.y) / dist) * power;
                    } else {
                        // 줄 곳이 없으면 공간으로 드리블 돌파 혹은 클리어
                        state.ball.vx = dir * 2.0;
                        state.ball.vy = (Math.random() - 0.5) * 4;
                    }
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
