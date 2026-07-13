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

    // 킥오프 위치로 초기화하는 함수
    function resetPositions(state, kickoffTeam) {
        state.ball = { x: 50, y: 50, vx: 0, vy: 0 };
        state.players.forEach(p => {
            p.x = p.baseX;
            p.y = p.baseY;
        });
        // 킥오프하는 팀의 공격수 한 명을 공 바로 앞으로 배치
        const striker = state.players.find(p => p.team === kickoffTeam);
        if (striker) { striker.x = 50; striker.y = 51; }
    }

    function startMatchPhase(roomCode) {
        const room = rooms[roomCode];
        room.state = 'match';
        room.code = roomCode; // 내부 참조용
        
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]];
        const p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions;
        const p2Formation = db.formations[p2Data.formation].positions;

        room.matchState = {
            ticks: 0,
            half: 1, // 1: 전반, 2: 후반
            score: { team1: 0, team2: 0 },
            isPaused: false, // 골이나 이벤트 발생 시 물리연산 일시정지
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => {
                    const pos = p1Formation[t.slot];
                    return { ...t.player, team: 1, slotIdx: idx, x: pos.x / 2, y: pos.y, baseX: pos.x / 2, baseY: pos.y };
                }),
                ...p2Data.team.map((t, idx) => {
                    const pos = p2Formation[t.slot];
                    return { ...t.player, team: 2, slotIdx: idx, x: 100 - (pos.x / 2), y: 100 - pos.y, baseX: 100 - (pos.x / 2), baseY: 100 - pos.y };
                })
            ]
        };

        io.to(roomCode).emit('matchStarted', room.matchState);

        room.matchInterval = setInterval(() => {
            const state = room.matchState;
            if (state.isPaused) return; // 일시 정지 중이면 연산 스킵

            state.ticks++;

            // [A] 공 이동 및 마찰력
            state.ball.x += state.ball.vx;
            state.ball.y += state.ball.vy;
            state.ball.vx *= 0.85; 
            state.ball.vy *= 0.85;
            
            // ★ 득점 판정 (Y좌표 40~60 사이를 골대로 간주)
            if (state.ball.x <= 2) {
                if (state.ball.y >= 40 && state.ball.y <= 60) handleGoal(room, 2); // 팀2 득점
                else state.ball.vx *= -1; // 골대 밖이면 튕김 (아웃 방지)
            } else if (state.ball.x >= 98) {
                if (state.ball.y >= 40 && state.ball.y <= 60) handleGoal(room, 1); // 팀1 득점
                else state.ball.vx *= -1;
            }
            if (state.ball.y <= 2 || state.ball.y >= 98) state.ball.vy *= -1;

            if (state.isPaused) return; // 골 처리로 일시정지 되었다면 아래 이동 연산 스킵

            // [B] A.I 거리 계산 및 가장 가까운 선수 찾기
            let minDist1 = Infinity, minDist2 = Infinity;
            let closest1 = null, closest2 = null;

            state.players.forEach(p => {
                let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
                if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
            });

            // [C] 선수 이동 및 [D] 슈팅/패스 로직 (이전과 동일)
            state.players.forEach(p => {
                let targetX = p.baseX, targetY = p.baseY;
                if (p === closest1 || p === closest2) {
                    targetX = state.ball.x; targetY = state.ball.y;
                } else {
                    let lineShift = (state.ball.x - 50) * 0.3;
                    targetX = Math.max(5, Math.min(95, p.baseX + lineShift));
                }

                let distToTarget = getDistance(p.x, p.y, targetX, targetY);
                let moveSpeed = (p.stats.spd || 70) / 100; 
                if (distToTarget > moveSpeed) {
                    p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                    p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
                }

                let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                if (distToBall < 2.5) { 
                    let targetGoalX = (p.team === 1) ? 100 : 0;
                    if (Math.abs(p.x - targetGoalX) < 35) {
                        let power = (p.stats.sht || 70) / 20; 
                        let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);
                        state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                        state.ball.vy = ((50 - p.y) / distToGoal) * power;
                    } else {
                        let power = (p.stats.pas || 70) / 30;
                        state.ball.vx = (p.team === 1 ? 1 : -1) * power;
                        state.ball.vy = (Math.random() - 0.5) * 2;
                    }
                }
            });

            // 시간 및 이벤트 계산
            let secondsPassed = Math.floor(state.ticks / 10);
            let gameMinute = Math.floor((secondsPassed / db.settings.halfDurationRealSeconds) * db.settings.gameMinutesPerHalf);
            if (state.half === 2) gameMinute += 45; // 후반전이면 45분 추가

            let eventText = "오픈 플레이";
            // 2초마다 확률적으로 이벤트 발생 (파울, 스로인 등)
            if (state.ticks % 20 === 0) {
                const totalWeight = db.matchEvents.reduce((sum, e) => sum + e.weight, 0);
                let rand = Math.random() * totalWeight;
                for (let e of db.matchEvents) {
                    if (rand < e.weight) { eventText = e.type; break; }
                    rand -= e.weight;
                }
                
                // 이벤트 발생 시 2초간 정지 후 재개
                if (eventText !== "오픈 플레이") {
                    state.isPaused = true;
                    io.to(roomCode).emit('matchEventAlert', eventText);
                    setTimeout(() => { state.isPaused = false; }, 2000);
                }
            }

            io.to(roomCode).emit('matchUpdate', {
                gameMinute: gameMinute, event: eventText, ball: state.ball, players: state.players, score: state.score
            });

            // 하프타임 및 경기 종료 체크
            if (secondsPassed >= db.settings.halfDurationRealSeconds) {
                clearInterval(room.matchInterval);
                if (state.half === 1) startHalfTime(roomCode);
                else io.to(roomCode).emit('matchEnded', state.score); // 후반전 종료 시
            }
        }, 100); 
    }

    // 골 발생 시 처리 함수
    function handleGoal(room, scoringTeam) {
        room.matchState.isPaused = true;
        room.matchState.score[`team${scoringTeam}`]++;
        io.to(room.code).emit('goalScored', { team: scoringTeam, score: room.matchState.score });
        
        // 3초 후 실점한 팀의 킥오프로 재개
        setTimeout(() => {
            resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1);
            room.matchState.isPaused = false;
        }, 3000);
    }

    // 하프타임 시작 로직
    function startHalfTime(roomCode) {
        const room = rooms[roomCode];
        io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
        
        setTimeout(() => {
            room.matchState.half = 2; // 후반전으로 설정
            room.matchState.ticks = 0; // 시간 초기화
            resetPositions(room.matchState, 2); // 후반전은 팀2의 킥오프로 시작
            io.to(roomCode).emit('secondHalfStarted');
            startMatchPhase(roomCode); // 타이머 재시작을 위해 호출 (내부적으로 인터벌 재설정)
        }, db.settings.halfTimeDurationRealSeconds * 1000);
    }

    // 하프타임 드래그 앤 드롭 진영 변경 수신
    socket.on('updatePositions', (roomCode, newPositions) => {
        const room = rooms[roomCode];
        if(!room || !room.matchState) return;
        
        // 클라이언트가 보낸 새로운 X, Y로 baseX, baseY 덮어쓰기
        newPositions.forEach(newPos => {
            const player = room.matchState.players.find(p => p.id === newPos.id && p.team === newPos.team);
            if(player) {
                player.baseX = newPos.x;
                player.baseY = newPos.y;
                player.x = newPos.x;
                player.y = newPos.y;
            }
        });
    });

// Render 등 클라우드 배포 시 자동으로 할당되는 포트를 사용합니다.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
