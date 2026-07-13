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
        const gkStats = { spd: 82, sht: 85, pas: 70 };

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

        // --- 1. 공 물리 연산 ---
        state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
        state.ball.vx *= 0.88; state.ball.vy *= 0.88;
        if (state.ball.y <= 2 || state.ball.y >= 98) state.ball.vy *= -1; // 터치라인 아웃 방지
        
        // 득점 판정 (골대 폭 38% ~ 62%로 확대)
        if (state.ball.x <= 1.5) {
            if (state.ball.y >= 38 && state.ball.y <= 62) handleGoal(room, 2); 
            else { state.ball.vx *= -1; state.ball.x = 2; }
        } else if (state.ball.x >= 98.5) {
            if (state.ball.y >= 38 && state.ball.y <= 62) handleGoal(room, 1); 
            else { state.ball.vx *= -1; state.ball.x = 98; }
        }
        if (state.isPaused) return; 

        // --- 2. 소유권 및 가장 가까운 선수 파악 ---
        let minDist1 = Infinity, minDist2 = Infinity;
        let closest1 = null, closest2 = null;
        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
            if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
        });

        // 공 소유권 판단 (더 가까운 팀이 소유)
        if(minDist1 < minDist2 && minDist1 < 15) state.possessionTeam = 1;
        else if(minDist2 <= minDist1 && minDist2 < 15) state.possessionTeam = 2;
        const attTeam = state.possessionTeam;

        // --- 3. 고급 전술 AI 이동 연산 ---
        state.players.forEach(p => {
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; // ★ 팀2 대칭 이동을 위한 절대 방향 벡터
            let targetGoalX = (p.team === 1) ? 100 : 0;
            let ownGoalX = (p.team === 1) ? 0 : 100;

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 2);
                targetY = Math.max(38, Math.min(62, state.ball.y)); // 골대 앞에서 슈팅 각도 좁히기
                if(getDistance(p.x, p.y, state.ball.x, state.ball.y) < 12) { targetX = state.ball.x; targetY = state.ball.y; }
            } 
            else if (p === closest1 || p === closest2) {
                // 각 팀 공과 가장 가까운 선수는 볼 차단/드리블을 위해 공을 향해 질주
                targetX = state.ball.x; targetY = state.ball.y;
            } 
            else if (attTeam === p.team) {
                // ================= [공격 전술: 팀 빌드업 & 오버래핑 & 침투] =================
                if (p.role === 'DF') {
                    if (p.posId.includes('L') || p.posId.includes('R') || p.posId === 'RB' || p.posId === 'LB') {
                        // ★ 풀백 오버래핑: 터치라인을 타고 상대 진영 깊숙이 침투
                        targetX = Math.min(85, Math.max(15, state.ball.x + (dir * 20)));
                        targetY = p.baseY; 
                    } else {
                        // ★ CB U자 빌드업: 후방에서 좌우로 넓게 벌려 패스 길 제공
                        targetX = ownGoalX + (dir * 30);
                        targetY = p.baseY + ((state.ball.y > 50) ? -10 : 10);
                    }
                } 
                else if (p.role === 'MF') {
                    // ★ 미드필더 티키타카 & 삼각 대형: 공 가진 선수 주변 15~20 거리에 삼각형으로 위치
                    targetX = state.ball.x + (dir * 12);
                    targetY = p.baseY + ((state.ball.y - p.baseY) * 0.4);
                } 
                else if (p.role === 'FW') {
                    if (p.posId.includes('W') || p.posId === 'LW' || p.posId === 'RW') {
                        // ★ 윙어 사이드 플레이: 측면 구석(크로스 존)으로 전력 질주
                        targetX = targetGoalX - (dir * 10);
                        targetY = p.baseY;
                    } else {
                        // ★ 스트라이커(ST): 중앙 페널티 박스(포스트) 안에서 컷백/크로스 대기
                        targetX = targetGoalX - (dir * 12);
                        targetY = 50 + (Math.random() - 0.5) * 20;
                    }
                }
            } 
            else {
                // ================= [수비 전술: 지역 수비 & 길목 차단] =================
                let defLine = state.ball.x - (dir * 15); // 공보다 살짝 뒤쪽에 수비 벽 형성
                if (p.role === 'DF') {
                    // ★ 지역 수비: 공과 우리 골대 사이의 각도를 좁히며 페널티 박스 사수
                    targetX = Math.max(10, Math.min(90, ownGoalX + (dir * 20)));
                    targetY = p.baseY + ((state.ball.y - 50) * 0.3);
                } 
                else if (p.role === 'MF') {
                    // 미드필더 2선 압박 및 패스 차단
                    targetX = Math.max(15, Math.min(85, defLine));
                    targetY = p.baseY + ((state.ball.y - p.baseY) * 0.6);
                } 
                else if (p.role === 'FW') {
                    // 전방 역습 대기 (하프라인 근처)
                    targetX = 50 + (dir * 10);
                    targetY = p.baseY;
                }
            }

            // 부드러운 속도 비례 이동
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            let moveSpeed = (p.stats.spd || 75) / 65; 
            if (p === closest1 || p === closest2) moveSpeed *= 1.15; // 공 쫓을 땐 스프린트

            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 4. 액션 로직 (패스, 크로스, 컷백, 슈팅) ---
            let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (distToBall < 2.5) { 
                io.to(roomCode).emit('playSound', 'kick');
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                if (p.role === 'GK') {
                    // 키퍼 골킥/클리어링 -> 우리 팀 전방 전개
                    state.ball.vx = dir * 4.5; state.ball.vy = (Math.random() - 0.5) * 3;
                } 
                else if (distToGoal < 28) {
                    // ★ 페널티 박스 내 완벽한 찬스 -> 강력한 슈팅!
                    let power = (p.stats.sht || 80) / 14; 
                    state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                    state.ball.vy = ((50 - p.y) / distToGoal) * power;
                } 
                else if (distToGoal < 42 && Math.random() < 0.25) {
                    // ★ 중거리슛 과감한 시도 (25% 확률)
                    let power = (p.stats.sht || 80) / 13; 
                    state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                    state.ball.vy = ((50 - p.y) / distToGoal) * power + (Math.random()-0.5);
                } 
                else if ((p.y < 18 || p.y > 82) && Math.abs(p.x - targetGoalX) < 25) {
                    // ★ 측면 깊은 곳 -> 중앙 ST를 향한 날카로운 크로스 & 컷백!
                    let power = (p.stats.pas || 80) / 16;
                    let targetY_cutback = 50 + (Math.random() - 0.5) * 15;
                    let distToBox = getDistance(p.x, p.y, targetGoalX - (dir*8), targetY_cutback);
                    state.ball.vx = ((targetGoalX - (dir*8) - p.x) / distToBox) * power;
                    state.ball.vy = ((targetY_cutback - p.y) / distToBox) * power;
                } 
                else {
                    // ★ 티키타카 & U자 패스 전개: 나보다 전방/오픈된 우리 팀 찾아 패스
                    let teammates = state.players.filter(m => m.team === p.team && m !== p && m.role !== 'GK');
                    // 전방에 있는 선수 우선 정렬
                    teammates.sort((a,b) => (dir === 1) ? b.x - a.x : a.x - b.x);
                    let targetMate = teammates[0] || teammates[Math.floor(Math.random()*teammates.length)];
                    
                    let power = (p.stats.pas || 80) / 22;
                    let distMate = getDistance(p.x, p.y, targetMate.x, targetMate.y);
                    state.ball.vx = ((targetMate.x - p.x) / distMate) * power;
                    state.ball.vy = ((targetMate.y - p.y) / distMate) * power;
                }
            }
        });

        // 타이머 (분:초)
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
