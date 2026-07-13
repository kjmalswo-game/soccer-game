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
            // 들어온 '참가자' 본인에게만 방 세팅 정보(DB) 전송
            socket.emit('roomJoined', roomCode, db); 
            // 방장과 참가자 '모두'에게 입장이 완료되었다고 알림
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
        if(!room || !room.players[socket.id]) return; // 방이 없거나 비정상 접근 차단
        // 해당 유저의 준비 상태 업데이트
        room.players[socket.id].formation = formationId;
        room.players[socket.id].ready = true;
        // 방 안에 있는 모든 유저가 준비되었는지 확인
        const playersArr = Object.values(room.players);
        const allReady = playersArr.every(p => p.ready);
        // ★ 반드시 "두 명"이 모두 들어왔고, "모두 준비완료" 상태일 때만 게임 시작
        if (allReady && playersArr.length === 2) {
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
    // --- 헬퍼 함수 모음 ---
    function getDistance(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); }
    
    // 포지션 ID로 역할군 분류
    function getRole(posId) {
        if (!posId) return 'MF';
        if (posId.includes('B')) return 'DF'; // CB, LB, RB, LWB, RWB
        if (posId.includes('T') || posId.includes('W') || posId === 'CF') return 'FW'; // ST, LW, RW, CF
        return 'MF'; // CM, CDM, CAM, LM, RM
    }

    function resetPositions(state, kickoffTeam) {
        state.ball = { x: 50, y: 50, vx: 0, vy: 0 };
        state.players.forEach(p => { p.x = p.baseX; p.y = p.baseY; });
        const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW');
        if (striker) { striker.x = 50; striker.y = 51; }
    }

    function startMatchPhase(roomCode) {
        const room = rooms[roomCode];
        room.state = 'match';
        room.code = roomCode; 
        
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]];
        const p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions;
        const p2Formation = db.formations[p2Data.formation].positions;

        // ★ 골키퍼 기본 능력치 설정
        const gkStats = { spd: 80, sht: 85, pas: 60 };

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, isPaused: false,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                // 팀 1 필드 플레이어
                ...p1Data.team.map((t, idx) => {
                    const pos = p1Formation[t.slot];
                    return { ...t.player, team: 1, role: getRole(pos.id), slotIdx: idx, x: pos.x / 2, y: pos.y, baseX: pos.x / 2, baseY: pos.y };
                }),
                // 팀 1 골키퍼 추가
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats },
                
                // 팀 2 필드 플레이어
                ...p2Data.team.map((t, idx) => {
                    const pos = p2Formation[t.slot];
                    return { ...t.player, team: 2, role: getRole(pos.id), slotIdx: idx, x: 100 - (pos.x / 2), y: 100 - pos.y, baseX: 100 - (pos.x / 2), baseY: 100 - pos.y };
                }),
                // 팀 2 골키퍼 추가
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats }
            ]
        };

        // 매치 시작 및 킥오프 휘슬 소리 재생
        io.to(roomCode).emit('matchStarted', room.matchState);
        io.to(roomCode).emit('playSound', 'whistle');

        room.matchInterval = setInterval(() => {
            const state = room.matchState;
            if (state.isPaused) return; 

            state.ticks++;

            // [A] 공 이동 및 마찰력
            state.ball.x += state.ball.vx;
            state.ball.y += state.ball.vy;
            state.ball.vx *= 0.85; 
            state.ball.vy *= 0.85;
            
            // 득점 판정
            if (state.ball.x <= 2) {
                if (state.ball.y >= 40 && state.ball.y <= 60) handleGoal(room, 2); 
                else state.ball.vx *= -1; 
            } else if (state.ball.x >= 98) {
                if (state.ball.y >= 40 && state.ball.y <= 60) handleGoal(room, 1); 
                else state.ball.vx *= -1;
            }
            if (state.ball.y <= 2 || state.ball.y >= 98) state.ball.vy *= -1;

            if (state.isPaused) return; 

            // [B] 공과 가장 가까운 선수 찾기 (팀별 소유권 계산용)
            let minDist1 = Infinity, minDist2 = Infinity;
            let closest1 = null, closest2 = null;

            state.players.forEach(p => {
                let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
                if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
            });

            // 현재 공에 더 가까운 팀 (공격권)
            const attackingTeam = minDist1 < minDist2 ? 1 : 2;

            // [C] 포지션별 고유 A.I 로직
            state.players.forEach(p => {
                let targetX = p.baseX, targetY = p.baseY;
                
                if (p.role === 'GK') {
                    // ★ 골키퍼 A.I: 골대(Y: 50)를 중심으로 상하로만 움직이며 슛 방어
                    targetX = p.baseX;
                    // 공이 페널티 박스 근처(우리 진영 30% 이내)로 오면 공의 Y축을 따라다님
                    if ((p.team === 1 && state.ball.x < 30) || (p.team === 2 && state.ball.x > 70)) {
                        targetY = Math.max(40, Math.min(60, state.ball.y));
                    } else {
                        targetY = 50; // 평소엔 정중앙 대기
                    }
                } 
                else if (p === closest1 || p === closest2) {
                    // ★ 각 팀에서 가장 공과 가까운 1명은 무조건 공을 쫓아감
                    targetX = state.ball.x; targetY = state.ball.y;
                } 
                else {
                    // ★ 역할군(Role)별 전술적 움직임
                    let dir = (p.team === 1) ? 1 : -1;
                    
                    if (p.role === 'DF') {
                        // 수비수: 공이 있는 위치에 맞춰 라인을 유지하고 골대 앞 공간 차단
                        let lineShift = (state.ball.x - 50) * 0.2;
                        targetX = Math.max(10, Math.min(90, p.baseX + lineShift));
                        targetY = p.baseY + (state.ball.y - 50) * 0.1;
                    } 
                    else if (p.role === 'MF') {
                        // 미드필더: 공수를 오가며 패스 길 확보
                        let lineShift = (state.ball.x - 50) * 0.4;
                        targetX = p.baseX + lineShift;
                        targetY = p.baseY + (state.ball.y - 50) * 0.2;
                    } 
                    else if (p.role === 'FW') {
                        // 공격수: 우리 팀이 공을 잡으면 전방 침투, 뺏기면 제자리 대기
                        let runForward = (attackingTeam === p.team) ? 15 * dir : 0;
                        targetX = Math.max(5, Math.min(95, p.baseX + (state.ball.x - 50) * 0.3 + runForward));
                        targetY = p.baseY;
                    }
                }

                // 이동 계산
                let distToTarget = getDistance(p.x, p.y, targetX, targetY);
                let moveSpeed = (p.stats.spd || 70) / 100; 
                // 골키퍼는 반응속도(이동속도)가 더 빠름
                if (p.role === 'GK') moveSpeed *= 1.2; 

                if (distToTarget > moveSpeed) {
                    p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                    p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
                }

                // [D] 공 터치 및 슈팅/클리어링 로직
                let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                if (distToBall < 2.5) { 
                    // ★ 킥 사운드 재생 이벤트 전송
                    io.to(roomCode).emit('playSound', 'kick');

                    let targetGoalX = (p.team === 1) ? 100 : 0;
                    
                    if (p.role === 'GK') {
                        // 골키퍼가 공을 잡으면 강하게 전방으로 걷어냄 (Clearance)
                        state.ball.vx = (p.team === 1 ? 1 : -1) * 4.0;
                        state.ball.vy = (Math.random() - 0.5) * 3;
                    } 
                    else if (Math.abs(p.x - targetGoalX) < 35) {
                        // 슈팅
                        let power = (p.stats.sht || 70) / 20; 
                        let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);
                        state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                        state.ball.vy = ((50 - p.y) / distToGoal) * power;
                    } 
                    else {
                        // 패스 및 드리블
                        let power = (p.stats.pas || 70) / 30;
                        state.ball.vx = (p.team === 1 ? 1 : -1) * power;
                        state.ball.vy = (Math.random() - 0.5) * 2.5;
                    }
                }
            });

            // 시간 계산 및 프론트엔드 전송
            let secondsPassed = Math.floor(state.ticks / 10);
            let gameMinute = Math.floor((secondsPassed / db.settings.halfDurationRealSeconds) * db.settings.gameMinutesPerHalf);
            if (state.half === 2) gameMinute += 45; 

            io.to(roomCode).emit('matchUpdate', {
                gameMinute: gameMinute, event: "오픈 플레이", ball: state.ball, players: state.players, score: state.score
            });

            if (secondsPassed >= db.settings.halfDurationRealSeconds) {
                clearInterval(room.matchInterval);
                io.to(roomCode).emit('playSound', 'whistle'); // 전후반 종료 휘슬
                if (state.half === 1) startHalfTime(roomCode);
                else io.to(roomCode).emit('matchEnded', state.score); 
            }
        }, 100); 
    }

    // 골 발생 함수 수정 (휘슬 사운드 추가)
    function handleGoal(room, scoringTeam) {
        room.matchState.isPaused = true;
        room.matchState.score[`team${scoringTeam}`]++;
        io.to(room.code).emit('playSound', 'whistle');
        io.to(room.code).emit('goalScored', { team: scoringTeam, score: room.matchState.score });
        
        setTimeout(() => {
            resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1);
            io.to(room.code).emit('playSound', 'whistle'); // 킥오프 휘슬
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
