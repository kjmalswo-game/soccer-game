const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// CORS 설정: 프론트엔드가 어디에 있든 접속을 허용합니다.
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
const rooms = {};

const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            players: { [socket.id]: { id: 'player1', ready: false, team: [] } },
            settings: { timer: db.settings.draftTimers[1], formation: null },
            state: 'lobby'
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode, db);
    });

    socket.on('joinRoom', (roomCode) => {
        if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length < 2) {
            rooms[roomCode].players[socket.id] = { id: 'player2', ready: false, team: [] };
            socket.join(roomCode);
            io.to(roomCode).emit('playerJoined', db);
        } else {
            socket.emit('error', '방이 가득 찼거나 존재하지 않습니다.');
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
        if(!room) return;
        
        room.players[socket.id].formation = formationId;
        room.players[socket.id].ready = true;

        const allReady = Object.values(room.players).every(p => p.ready);
        if (allReady && Object.keys(room.players).length === 2) {
            startDraftPhase(roomCode);
        }
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
            startMatchPhase(roomCode);
            return;
        }
        
        const p1Player = db.players[Math.floor(Math.random() * db.players.length)];
        const p2Player = db.players[Math.floor(Math.random() * db.players.length)];
        
        room.currentDraft = { p1: p1Player, p2: p2Player, answers: 0 };
        io.to(roomCode).emit('draftPlayer', { p1: p1Player, p2: p2Player, timeLimit: room.settings.timer });
        
        room.draftTimeout = setTimeout(() => {
            io.to(roomCode).emit('forceRandomPlacement');
        }, room.settings.timer * 1000);
    }

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

    // --- 헬퍼 함수: 두 점 사이의 거리 계산 ---
    function getDistance(x1, y1, x2, y2) {
        return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    }

    function startMatchPhase(roomCode) {
        const room = rooms[roomCode];
        room.state = 'match';
        
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]];
        const p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions;
        const p2Formation = db.formations[p2Data.formation].positions;

        // 1. 공과 선수들의 초기 상태 (baseX, baseY는 돌아갈 기본 위치)
        room.matchState = {
            ticks: 0, // 0.1초마다 1씩 증가
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map(t => {
                    const pos = p1Formation[t.slot];
                    const startX = pos.x / 2;
                    return { ...t.player, team: 1, x: startX, y: pos.y, baseX: startX, baseY: pos.y };
                }),
                ...p2Data.team.map(t => {
                    const pos = p2Formation[t.slot];
                    const startX = 100 - (pos.x / 2);
                    return { ...t.player, team: 2, x: startX, y: 100 - pos.y, baseX: startX, baseY: 100 - pos.y };
                })
            ]
        };

        io.to(roomCode).emit('matchStarted', room.matchState);

        // 2. 물리 엔진 루프 (0.1초 = 100ms마다 실행)
        room.matchInterval = setInterval(() => {
            const state = room.matchState;
            state.ticks++;

            // --- [A] 공 이동 및 마찰력 로직 ---
            state.ball.x += state.ball.vx;
            state.ball.y += state.ball.vy;
            state.ball.vx *= 0.85; // 잔디 마찰력 (속도 감소)
            state.ball.vy *= 0.85;
            
            // 공이 벽에 튕기도록 처리 (간단한 아웃 방지)
            if (state.ball.x <= 2 || state.ball.x >= 98) state.ball.vx *= -1;
            if (state.ball.y <= 2 || state.ball.y >= 98) state.ball.vy *= -1;

            // --- [B] 팀별 공과 가장 가까운 선수 찾기 ---
            let minDist1 = Infinity, minDist2 = Infinity;
            let closest1 = null, closest2 = null;

            state.players.forEach(p => {
                let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
                if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
            });

            // --- [C] 선수 이동 로직 (A.I) ---
            state.players.forEach(p => {
                let targetX = p.baseX;
                let targetY = p.baseY;

                // 1) 내가 팀에서 공과 가장 가깝다면? -> 공을 향해 달린다.
                if (p === closest1 || p === closest2) {
                    targetX = state.ball.x;
                    targetY = state.ball.y;
                } else {
                    // 2) 아니라면? -> 공의 위치에 맞춰 라인을 약간씩 올리거나 내린다 (포메이션 유지)
                    let lineShift = (state.ball.x - 50) * 0.3; // 공 위치에 따라 최대 15% 정도 이동
                    targetX = Math.max(5, Math.min(95, p.baseX + lineShift));
                }

                // 이동 계산 (선수의 스피드 능력치 반영)
                let distToTarget = getDistance(p.x, p.y, targetX, targetY);
                // spd 80 기준 -> 한 틱당 약 0.8 이동
                let moveSpeed = (p.stats.spd || 70) / 100; 
                
                if (distToTarget > moveSpeed) {
                    p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                    p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
                }

                // --- [D] 공 터치 및 킥 로직 ---
                let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                if (distToBall < 2.5) { // 공과 닿았다면
                    let isShooting = false;
                    let targetGoalX = (p.team === 1) ? 100 : 0;
                    
                    // 골대(x: 100 또는 0)와의 거리가 35 이하면 슈팅 시도
                    if (Math.abs(p.x - targetGoalX) < 35) {
                        isShooting = true;
                    }

                    if (isShooting) {
                        // 슈팅 로직 (골대 정중앙 Y: 50을 향해, 슈팅 능력치 비례 파워)
                        let power = (p.stats.sht || 70) / 20; // 3.5 ~ 5.0 파워
                        let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);
                        state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                        state.ball.vy = ((50 - p.y) / distToGoal) * power;
                    } else {
                        // 패스 로직 (단순화: 상대 골대 방향으로 가볍게 툭 쳐놓기 = 드리블/전진 패스)
                        let power = (p.stats.pas || 70) / 30; // 2.0 ~ 3.0 파워
                        state.ball.vx = (p.team === 1 ? 1 : -1) * power;
                        state.ball.vy = (Math.random() - 0.5) * 2; // Y축으로 약간의 랜덤성
                    }
                }
            });

            // 1초(10틱)마다 시간 계산
            let secondsPassed = Math.floor(state.ticks / 10);
            let gameMinute = Math.floor((secondsPassed / db.settings.halfDurationRealSeconds) * db.settings.gameMinutesPerHalf);

            // 이벤트 텍스트 갱신 (1초마다)
            let eventText = "오픈 플레이";
            if (state.ticks % 10 === 0) {
                const totalWeight = db.matchEvents.reduce((sum, e) => sum + e.weight, 0);
                let rand = Math.random() * totalWeight;
                for (let e of db.matchEvents) {
                    if (rand < e.weight) { eventText = e.type; break; }
                    rand -= e.weight;
                }
            }

            // 프론트엔드로 0.1초마다 좌표 데이터 전송
            io.to(roomCode).emit('matchUpdate', {
                gameMinute: gameMinute,
                event: eventText,
                ball: state.ball,
                players: state.players
            });

            // 전반전 종료 체크
            if (secondsPassed >= db.settings.halfDurationRealSeconds) {
                clearInterval(room.matchInterval);
                startHalfTime(roomCode);
            }
        }, 100); // 100ms (0.1초) 
    }

    function startHalfTime(roomCode) {
        io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds);
        setTimeout(() => {
            io.to(roomCode).emit('secondHalfStarted');
        }, db.settings.halfTimeDurationRealSeconds * 1000);
    }
});

// Render 등 클라우드 배포 시 자동으로 할당되는 포트를 사용합니다.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
