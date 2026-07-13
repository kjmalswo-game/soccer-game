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
    state.players.forEach(p => { 
        p.x = p.baseX; p.y = p.baseY; p.cooldown = 0; 
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
        const gkStats = { spd: 82, sht: 85, pas: 80 };

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, 
            phase: 'play', // play, throw_in, corner, goal_kick
            setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이",
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
        room.matchState.half = 2; room.matchState.ticks = 0; room.matchState.phase = 'play';
        resetPositions(room.matchState, 2);
    }

    io.to(roomCode).emit('matchStarted', room.matchState);
    io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        state.ticks++;

        // ★ 세트피스 상황 처리 (일시정지 및 전술 대형 배치)
        if (state.phase !== 'play') {
            state.setPieceTimer--;
            if (state.setPieceTimer <= 0) {
                // 세트피스 킥 실행
                io.to(roomCode).emit('playSound', 'kick');
                let dir = (state.possessionTeam === 1) ? 1 : -1;
                
                if (state.phase === 'throw_in') {
                    state.ball.vx = dir * 2.5; state.ball.vy = (Math.random() - 0.5) * 3;
                } else if (state.phase === 'corner') {
                    // 골문 앞으로 크로스
                    let targetX = (state.possessionTeam === 1) ? 92 : 8;
                    let targetY = 50 + (Math.random() - 0.5) * 15;
                    let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY);
                    state.ball.vx = ((targetX - state.ball.x) / dist) * 4.5;
                    state.ball.vy = ((targetY - state.ball.y) / dist) * 4.5;
                } else if (state.phase === 'goal_kick') {
                    // 하프라인 쪽으로 롱킥
                    state.ball.vx = dir * 6.0; state.ball.vy = (Math.random() - 0.5) * 4;
                }
                
                state.players.forEach(p => p.cooldown = 5); // 킥 직후 딜레이
                state.phase = 'play';
                state.eventText = "오픈 플레이";
            }
            // 세트피스 중에는 UI 업데이트만 하고 물리 연산 건너뜀
            emitUpdate(roomCode, state);
            return;
        }

        // --- 1. 물리 연산 ---
        state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
        state.ball.vx *= 0.88; state.ball.vy *= 0.88; 
        
        // --- 2. 아웃 오브 바운드 시스템 (스로인 / 골킥 / 코너킥 / 득점) ---
        if (state.ball.y <= 0 || state.ball.y >= 100) {
            setupSetPiece(state, 'throw_in'); return;
        }
        if (state.ball.x <= 0) {
            if (state.ball.y >= 38 && state.ball.y <= 62) { handleGoal(room, 2); return; }
            else { setupSetPiece(state, state.lastTouchTeam === 1 ? 'corner' : 'goal_kick', 1); return; }
        } else if (state.ball.x >= 100) {
            if (state.ball.y >= 38 && state.ball.y <= 62) { handleGoal(room, 1); return; }
            else { setupSetPiece(state, state.lastTouchTeam === 2 ? 'corner' : 'goal_kick', 2); return; }
        }

        // --- 3. 소유권 및 게임 템포 파악 ---
        let minDist1 = Infinity, minDist2 = Infinity;
        let closest1 = null, closest2 = null;
        state.players.forEach(p => {
            let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (p.team === 1 && dist < minDist1) { minDist1 = dist; closest1 = p; }
            if (p.team === 2 && dist < minDist2) { minDist2 = dist; closest2 = p; }
        });

        let oldPossession = state.possessionTeam;
        if(minDist1 < minDist2 && minDist1 < 10) state.possessionTeam = 1;
        else if(minDist2 <= minDist1 && minDist2 < 10) state.possessionTeam = 2;
        const attTeam = state.possessionTeam;

        // --- 4. 다이나믹 하이라인(Offside Line) 계산 ---
        let defLine1 = 20, defLine2 = 80;
        state.players.forEach(p => {
            if(p.role === 'FW') {
                if(p.team === 1 && p.x > defLine1) defLine1 = Math.min(p.x + 5, 90);
                if(p.team === 2 && p.x < defLine2) defLine2 = Math.max(p.x - 5, 10);
            }
        });

        // --- 5. 완전 자율 에이전트 AI 로직 ---
        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let ownGoalX = (p.team === 1) ? 0 : 100;
            let targetGoalX = (p.team === 1) ? 100 : 0;

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 3);
                targetY = Math.max(35, Math.min(65, state.ball.y)); // 각도 넓게 커버
                if(getDistance(p.x, p.y, state.ball.x, state.ball.y) < 18) { targetX = state.ball.x; targetY = state.ball.y; }
            } 
            else if (p === closest1 || p === closest2) {
                targetX = state.ball.x; targetY = state.ball.y; // 팀별 1명은 무조건 공 압박
            } 
            else if (attTeam === p.team) {
                // ★ [공격] 유기적 전진, 하이라인, 스위칭
                if (p.role === 'DF') {
                    // 수비수도 적극적으로 하프라인 너머로 라인을 올림 (빌드업 참여)
                    targetX = Math.max(30, Math.min(70, state.ball.x - (dir * 20)));
                    targetY = p.baseY + ((state.ball.y - 50) * 0.4); 
                    if(p.posId.includes('B') && !p.posId.includes('C')) { // 풀백 오버래핑
                        targetX += (dir * 20); targetY = (p.baseY > 50) ? 95 : 5;
                    }
                } 
                else if (p.role === 'MF') {
                    // 미드필더는 공격수처럼 박스 근처로 적극 침투 (이분법 탈피)
                    targetX = state.ball.x + (dir * 18);
                    targetY = p.baseY + (Math.random() - 0.5) * 20; 
                    if(state.ball.x > 75 || state.ball.x < 25) targetX = targetGoalX - (dir*15); // 크로스 상황 시 박스 쇄도
                } 
                else if (p.role === 'FW') {
                    // 공간 창출 침투 런
                    targetX = (p.team === 1) ? Math.min(defLine2, 95) : Math.max(defLine1, 5);
                    targetY = state.ball.y + (Math.random() - 0.5) * 30;
                }
            } 
            else {
                // ★ [수비] 적응형 수비 라인, 대인 마크, 전방 압박
                let isHighPress = (p.team === 1 && state.ball.x > 50) || (p.team === 2 && state.ball.x < 50);

                if (p.role === 'DF') {
                    // 상대 공격수 위치(defLine)에 맞춰 점진적으로 라인 무르기
                    targetX = (p.team === 1) ? Math.max(10, defLine2 - 10) : Math.min(90, defLine1 + 10);
                    targetY = p.baseY + ((state.ball.y - 50) * 0.5);
                } 
                else if (p.role === 'MF') {
                    // 수비와 공격 사이 간격 유지 및 적극적 대인 마크
                    targetX = state.ball.x - (dir * 15);
                    targetY = state.ball.y + (p.baseY > 50 ? 10 : -10);
                } 
                else if (p.role === 'FW') {
                    // ★ 전방 압박 (가만히 있지 않고 적극적으로 내려와 압박)
                    if(isHighPress) {
                        targetX = state.ball.x + (dir * 5); 
                        targetY = state.ball.y + (Math.random() - 0.5) * 20;
                    } else {
                        // 하프라인 근처 역습 대기
                        targetX = 50 + (dir * 15); targetY = p.baseY;
                    }
                }
            }

            // 속도 대폭 상향 (90으로 나눔 - 기존 130)
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            let moveSpeed = (p.stats.spd || 80) / 90; 
            if (p === closest1 || p === closest2) moveSpeed *= 1.3; 
            
            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 6. 터치 및 볼 플레이 ---
            let distToBall = getDistance(p.x, p.y, state.ball.x, state.ball.y);
            if (distToBall < 3 && p.cooldown === 0) { 
                state.lastTouchTeam = p.team;
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                if (p.role === 'GK') {
                    io.to(roomCode).emit('playSound', 'kick');
                    state.ball.vx = dir * 7.0; state.ball.vy = (Math.random() - 0.5) * 5;
                    p.cooldown = 15;
                } 
                else if (distToGoal < 30) {
                    io.to(roomCode).emit('playSound', 'kick');
                    let power = (p.stats.sht || 85) / 12; 
                    state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                    state.ball.vy = ((50 - p.y) / distToGoal) * power;
                    p.cooldown = 10;
                } 
                else {
                    // ★ 전진성 패스 우선 로직
                    let bestMate = null; let maxScore = -999;
                    
                    state.players.forEach(m => {
                        if (m.team === p.team && m !== p && m.role !== 'GK') {
                            let forwardDist = (p.team === 1) ? m.x - p.x : p.x - m.x; 
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            // 전진하는 동료에게 무조건 압도적 가중치
                            let score = (forwardDist * 4) - dist; 
                            if (dist < 10 || dist > 50) score -= 100; // 너무 가깝거나 멀면 배제
                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    if (bestMate && maxScore > -50 && Math.random() < 0.7) {
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = (p.stats.pas || 80) / 15;
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                        state.ball.vx = ((bestMate.x - p.x) / d) * power;
                        state.ball.vy = ((bestMate.y - p.y) / d) * power;
                        p.cooldown = 10; 
                    } else {
                        // 드리블 전진
                        state.ball.vx = dir * 2.2;
                        state.ball.vy = (Math.random() - 0.5) * 1.5;
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

// 헬퍼: 클라이언트로 정보 전송
function emitUpdate(roomCode, state) {
    let totalTicks = state.ticks;
    let gameSeconds = (totalTicks / 10) * (db.settings.gameMinutesPerHalf * 60 / db.settings.halfDurationRealSeconds);
    if (state.half === 2) gameSeconds += 45 * 60; 

    io.to(roomCode).emit('matchUpdate', {
        gameSeconds: gameSeconds, event: state.eventText, ball: state.ball, players: state.players, score: state.score
    });
}

// 헬퍼: 세트피스 포메이션 세팅
function setupSetPiece(state, type, sideTeam = 1) {
    state.phase = type;
    state.setPieceTimer = 20; // 2초 대기
    state.ball.vx = 0; state.ball.vy = 0;

    if (type === 'throw_in') {
        state.eventText = "스로인";
        state.ball.y = state.ball.y <= 0 ? 1 : 99;
        // 공과 가장 가까운 선수가 스로인 담당
        let thrower = state.players.reduce((prev, curr) => 
            (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev)
        );
        thrower.x = state.ball.x; thrower.y = state.ball.y;
        state.possessionTeam = thrower.team;
    } 
    else if (type === 'corner') {
        state.eventText = "코너킥";
        state.possessionTeam = sideTeam === 1 ? 2 : 1;
        let goalX = sideTeam === 1 ? 5 : 95;
        state.ball.x = goalX; state.ball.y = (state.ball.y > 50) ? 98 : 2;
        
        // 박스 안으로 선수들 밀집
        state.players.forEach(p => {
            if(p.role !== 'GK') {
                p.x = goalX + (sideTeam === 1 ? 1 : -1) * (10 + Math.random()*15);
                p.y = 30 + Math.random() * 40;
            }
        });
        // 키커 배치
        let kicker = state.players.find(p => p.team === state.possessionTeam && p.role === 'FW');
        if(kicker) { kicker.x = state.ball.x; kicker.y = state.ball.y; }
    }
    else if (type === 'goal_kick') {
        state.eventText = "골킥";
        state.possessionTeam = sideTeam;
        let goalX = sideTeam === 1 ? 5 : 95;
        state.ball.x = goalX; state.ball.y = 50;
        
        // 골킥 포메이션 (넓게 벌림)
        state.players.forEach(p => {
            if (p.team === sideTeam) {
                if(p.role === 'DF') { p.x = goalX + (sideTeam===1?15:-15); p.y = p.baseY; }
                else if(p.role === 'MF') { p.x = 50; p.y = p.baseY; }
                else if(p.role === 'FW') { p.x = sideTeam===1?70:30; p.y = p.baseY; }
            } else {
                p.x = sideTeam===1? 60:40; // 상대팀은 전방 압박
            }
        });
        let gk = state.players.find(p => p.team === sideTeam && p.role === 'GK');
        if(gk) { gk.x = state.ball.x; gk.y = state.ball.y; }
    }
}

function handleGoal(room, scoringTeam) {
    room.matchState.phase = 'paused';
    room.matchState.ball.x = 50; room.matchState.ball.y = 50;
    room.matchState.ball.vx = 0; room.matchState.ball.vy = 0;
    room.matchState.score[`team${scoringTeam}`]++;
    room.matchState.eventText = "득점!!!";
    io.to(room.code).emit('playSound', 'whistle');
    io.to(room.code).emit('goalScored', { team: scoringTeam, score: room.matchState.score });
    
    setTimeout(() => {
        resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1);
        io.to(room.code).emit('playSound', 'whistle'); 
    }, 3000);
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    io.to(roomCode).emit('halfTimeStarted', db.settings.halfTimeDurationRealSeconds, room.matchState.players);
    setTimeout(() => { startMatchPhase(roomCode, true); }, db.settings.halfTimeDurationRealSeconds * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
