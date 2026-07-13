const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

let db;
try {
    db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
} catch(e) {
    console.error("🔥 database.json 파일 문법 에러!:", e);
}

const rooms = {};
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// 헬퍼 함수
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
            state: 'lobby',
            availablePlayers: [...db.players] // ★ 중복 방지를 위한 방 전용 선수 풀(Pool) 복사
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
        if (playersArr.every(p => p.ready) && playersArr.length === 2) {
            startDraftPhase(roomCode);
        }
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

    // ★ 하프타임 선수 교체 (Swap)
    socket.on('swapPlayers', (roomCode, teamId, id1, id2) => {
        const room = rooms[roomCode];
        if(!room || !room.matchState) return;
        
        const p1 = room.matchState.players.find(p => p.team === teamId && p.id == id1);
        const p2 = room.matchState.players.find(p => p.team === teamId && p.id == id2);
        
        if(p1 && p2) {
            // 두 선수의 기본 좌표(baseX, baseY)와 역할(role)을 맞바꿈
            let tempX = p1.baseX, tempY = p1.baseY, tempRole = p1.role;
            p1.baseX = p2.baseX; p1.baseY = p2.baseY; p1.role = p2.role;
            p1.x = p1.baseX; p1.y = p1.baseY;
            
            p2.baseX = tempX; p2.baseY = tempY; p2.role = tempRole;
            p2.x = p2.baseX; p2.y = p2.baseY;
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
    if (room.draftCount >= 10) {
        startMatchPhase(roomCode, false); // 전반전 시작
        return;
    }
    
    // ★ 중복 방지: 풀에서 무작위로 뽑고 제거함 (서로 다른 선수가 등장)
    function pullRandomPlayer() {
        if(room.availablePlayers.length === 0) return null;
        const idx = Math.floor(Math.random() * room.availablePlayers.length);
        return room.availablePlayers.splice(idx, 1)[0];
    }
    
    const p1Player = pullRandomPlayer();
    const p2Player = pullRandomPlayer();
    
    room.currentDraft = { p1: p1Player, p2: p2Player, answers: 0 };
    io.to(roomCode).emit('draftPlayer', { p1: p1Player, p2: p2Player, timeLimit: room.settings.timer });
    
    room.draftTimeout = setTimeout(() => {
        io.to(roomCode).emit('forceRandomPlacement');
    }, room.settings.timer * 1000);
}

// ★ isSecondHalf 파라미터 추가로 무한 루프 버그 해결
function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode];
    room.state = 'match';
    room.code = roomCode; 
    
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]];
        const p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions;
        const p2Formation = db.formations[p2Data.formation].positions;
        const gkStats = { spd: 80, sht: 85, pas: 60 };

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, isPaused: false,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => {
                    const pos = p1Formation[t.slot];
                    return { ...t.player, team: 1, role: getRole(pos.id), slotIdx: idx, x: pos.x / 2, y: pos.y, baseX: pos.x / 2, baseY: pos.y };
                }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats },
                ...p2Data.team.map((t, idx) => {
                    const pos = p2Formation[t.slot];
                    return { ...t.player, team: 2, role: getRole(pos.id), slotIdx: idx, x: 100 - (pos.x / 2), y: 100 - pos.y, baseX: 100 - (pos.x / 2), baseY: 100 - pos.y };
                }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats }
            ]
        };
    } else {
        room.matchState.half = 2;
        room.matchState.ticks = 0;
        room.matchState.isPaused = false;
        resetPositions(room.matchState, 2);
    }

    io.to(roomCode).emit('matchStarted', room.matchState);
    io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        if (state.isPaused) return; 

        state.ticks++;

        // 공 물리 연산
        state.ball.x += state.ball.vx;
        state.ball.y += state.ball.vy;
        state.ball.vx *= 0.90; // 잔디 마찰력 (공이 더 잘 구르게)
        state.ball.vy *= 0.90;
        
        // 공이 라인을 나가면 튕겨서 들어오도록 (코너킥/스로인 복잡도 제거용)
        if (state.ball.y <= 1 || state.ball.y >= 99) state.ball.vy *= -1;
        
        // 득점 판정 (X축 양끝 페널티 박스 라인 안쪽)
        if (state.ball.x <= 2) {
            if (state.ball.y >= 35 && state.ball.y <= 65) handleGoal(room, 2); 
            else { state.ball.vx *= -1; state.ball.x = 3; } // 골이 아니면 튕김
        } else if (state.ball.x >= 98) {
            if (state.ball.y >= 35 && state.ball.y <= 65) handleGoal(room, 1); 
            else { state.ball.vx *= -1; state.ball.x = 97; }
        }

        if (state.isPaused) return; 

        // AI 개선: 공과 가장 가까운 선수 파악
        let minDist1 = Infinity, minDist2 = Infinity;
        let closest1 = null, closest2 = null;

        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
            if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
        });

        const attackingTeam = minDist1 < minDist2 ? 1 : 2;

        // ★ 유기적인 필드 플레이어 AI 
        state.players.forEach(p => {
            let targetX = p.baseX, targetY = p.baseY;
            
            if (p.role === 'GK') {
                targetX = p.baseX;
                if (getDistance(p.x, p.y, state.ball.x, state.ball.y) < 15) {
                    targetY = state.ball.y; // 공이 페널티박스 근처면 쫓아감
                } else {
                    targetY = 50; 
                }
            } 
            else if (p === closest1 || p === closest2) {
                targetX = state.ball.x; targetY = state.ball.y; // 가장 가까운 사람은 공을 향해 달림
            } 
            else {
                // 팀 전체의 무게중심 이동 (라인 올리기/내리기)
                let pushUp = (attackingTeam === p.team) ? (p.team === 1 ? 15 : -15) : (p.team === 1 ? -10 : 10);
                
                if (p.role === 'DF') {
                    targetX = Math.max(10, Math.min(90, p.baseX + (state.ball.x - 50) * 0.15 + pushUp * 0.5));
                    targetY = p.baseY + (state.ball.y - 50) * 0.1;
                } 
                else if (p.role === 'MF') {
                    targetX = p.baseX + (state.ball.x - 50) * 0.3 + pushUp;
                    targetY = p.baseY + (state.ball.y - 50) * 0.3;
                } 
                else if (p.role === 'FW') {
                    targetX = p.baseX + (state.ball.x - 50) * 0.4 + pushUp * 1.5;
                    targetY = p.baseY + (state.ball.y - 50) * 0.2;
                }
            }

            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            let moveSpeed = (p.stats.spd || 70) / 70; // 이동 속도 밸런스 조정
            if (p.role === 'GK') moveSpeed *= 1.2; 

            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // 터치 및 슛/패스
            let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (distToBall < 2.5) { 
                io.to(roomCode).emit('playSound', 'kick');
                let targetGoalX = (p.team === 1) ? 100 : 0;
                
                if (p.role === 'GK') {
                    state.ball.vx = (p.team === 1 ? 1 : -1) * 4.5;
                    state.ball.vy = (Math.random() - 0.5) * 4;
                } 
                else if (Math.abs(p.x - targetGoalX) < 35) { // 슈팅 사거리
                    let power = (p.stats.sht || 70) / 15; 
                    let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);
                    state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                    state.ball.vy = ((50 - p.y) / distToGoal) * power;
                } 
                else { // 패스/클리어링
                    let power = (p.stats.pas || 70) / 25;
                    if(p.role === 'DF' && Math.abs(p.x - (p.team===1?0:100)) < 20) power *= 1.5; // 수비수 위험구역 걷어내기
                    state.ball.vx = (p.team === 1 ? 1 : -1) * power;
                    state.ball.vy = (Math.random() - 0.5) * 2.5;
                }
            }
        });

        // ★ 초(Seconds)가 포함된 타이머 계산 (게임 1초 = 0.1초 틱루프 * 배율)
        let totalTicks = state.ticks;
        let gameSeconds = (totalTicks / 10) * (db.settings.gameMinutesPerHalf * 60 / db.settings.halfDurationRealSeconds);
        if (state.half === 2) gameSeconds += 45 * 60; // 후반전 45분 더하기

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
    // 무한 골 방지: 공을 아예 멀리 치워버림
    room.matchState.ball.x = 50; 
    room.matchState.ball.y = 50;
    room.matchState.ball.vx = 0;
    room.matchState.ball.vy = 0;
    
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
    
    setTimeout(() => {
        startMatchPhase(roomCode, true); // ★ 무한 루프 버그 고침 (isSecondHalf = true 전달)
    }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
