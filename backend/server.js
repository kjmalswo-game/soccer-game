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
        } else {
            socket.emit('error', '방이 가득 찼거나 존재하지 않는 코드입니다.');
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
        if(!room || !room.currentDraft) return;
        const isP1 = room.players[socket.id].id === 'player1';
        if (isP1 && room.currentDraft.p1Placed) return;
        if (!isP1 && room.currentDraft.p2Placed) return;

        room.players[socket.id].team.push({ slot: slotId, player: playerInfo });
        room.currentDraft.answers++;
        if (isP1) room.currentDraft.p1Placed = true;
        else room.currentDraft.p2Placed = true;

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
    room.currentDraft = { p1: p1Player, p2: p2Player, answers: 0, p1Placed: false, p2Placed: false };
    io.to(roomCode).emit('draftPlayer', { p1: p1Player, p2: p2Player, timeLimit: room.settings.timer });
    
    room.draftTimeout = setTimeout(() => { 
        if(!room || !room.currentDraft) return;
        Object.keys(room.players).forEach(pId => {
            const pData = room.players[pId];
            const isP1 = pData.id === 'player1';
            const hasPlaced = isP1 ? room.currentDraft.p1Placed : room.currentDraft.p2Placed;
            if (!hasPlaced) {
                const filledSlots = pData.team.map(t => parseInt(t.slot));
                let emptySlot = -1;
                for(let i = 0; i < 10; i++) { if(!filledSlots.includes(i)) { emptySlot = i; break; } }
                if(emptySlot !== -1) {
                    const assignedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
                    pData.team.push({ slot: emptySlot, player: assignedPlayer });
                    io.to(pId).emit('autoPlaced', emptySlot, assignedPlayer); 
                }
                room.currentDraft.answers++;
                if(isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
            }
        });
        if (room.currentDraft.answers >= 2) { room.draftCount++; nextDraftTurn(roomCode); }
    }, room.settings.timer * 1000 + 1000);
}

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode];
    room.state = 'match'; room.code = roomCode; 
    
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]], p2Data = room.players[playerIds[1]];
        const p1Formation = db.formations[p1Data.formation].positions, p2Formation = db.formations[p2Data.formation].positions;
        const gkStats = { spd: 85, sht: 85, pas: 80 }; 

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

        // --- 1. 세트피스 및 골키퍼 캐칭 마그네틱 홀드 ---
        if (state.phase !== 'play') {
            if (state.phase === 'gk_hold' && state.gkHolder) {
                state.ball.x = state.gkHolder.x + (state.gkHolder.team === 1 ? 1.5 : -1.5); 
                state.ball.y = state.gkHolder.y;
                state.ball.vx = 0; state.ball.vy = 0;
            }

            state.setPieceTimer--;
            if (state.setPieceTimer <= 0) {
                io.to(roomCode).emit('playSound', 'kick');
                
                if (state.phase === 'gk_hold' && state.gkHolder) {
                    let p = state.gkHolder;
                    let bestMate = null; let maxScore = -999;
                    state.players.forEach(m => {
                        if (m.team === p.team && m.role !== 'GK') {
                            let minEnemyDist = Infinity;
                            state.players.forEach(e => {
                                if (e.team !== p.team && getDistance(m.x, m.y, e.x, e.y) < minEnemyDist) minEnemyDist = getDistance(m.x, m.y, e.x, e.y);
                            });
                            let dFromGk = getDistance(p.x, p.y, m.x, m.y);
                            let score = (minEnemyDist * 5) - dFromGk;
                            let isForward = (p.team === 1 && m.x > p.x) || (p.team === 2 && m.x < p.x);
                            if (isForward) score += 30;
                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    if (bestMate) {
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                        state.ball.vx = ((bestMate.x - p.x) / d) * 5.0; 
                        state.ball.vy = ((bestMate.y - p.y) / d) * 5.0;
                    } else {
                        let dir = (p.team === 1) ? 1 : -1;
                        state.ball.vx = dir * 6.0; state.ball.vy = (p.y > 50) ? 3.5 : -3.5;
                    }
                    p.cooldown = 20; 
                } 
                else {
                    let dir = (state.possessionTeam === 1) ? 1 : -1;
                    if (state.phase === 'throw_in') {
                        let mates = state.players.filter(p => p.team === state.possessionTeam && p.id !== state.throwerId && p.role !== 'GK');
                        mates.sort((a,b) => getDistance(state.ball.x, state.ball.y, a.x, a.y) - getDistance(state.ball.x, state.ball.y, b.x, b.y));
                        let target = mates[0];
                        if(target) {
                            let dist = getDistance(state.ball.x, state.ball.y, target.x, target.y);
                            state.ball.vx = ((target.x - state.ball.x) / dist) * 3.0;
                            state.ball.vy = ((target.y - state.ball.y) / dist) * 3.0;
                        } else { state.ball.vx = dir * 2.5; state.ball.vy = 0; }
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
            if (state.phase !== 'play' && state.phase !== 'gk_hold') { emitUpdate(roomCode, state); return; }
        }

        // --- 2. 물리 연산 ---
        if (state.phase === 'play') {
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
        }

        // --- 3. 소유권 및 거리 랭킹 계산 ---
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

        // --- 4. ★ 완벽한 지역 방어 + 적극적 CB 마킹 + 루즈볼/세컨볼 강화 + 모든 AI 변칙적 움직임 ---
        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let ownGoalX = (p.team === 1) ? 0 : 100;
            
            let myDistArr = (p.team === 1) ? distArr1 : distArr2;
            let rankObj = myDistArr.find(obj => obj.p === p);
            let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
            let distToBall = rankObj ? rankObj.dist : 999;
            let ballSpeed = Math.sqrt(state.ball.vx * state.ball.vx + state.ball.vy * state.ball.vy);
            let isLooseBall = ballSpeed > 1.8 || (minDist1 > 7 && minDist2 > 7);
            let isFinalThirdDef = getDistance(state.ball.x, state.ball.y, ownGoalX, 50) < 35;

            // ★ 고유 플레이어 변칙성 (단조로운 반복 패턴 완전 배제 - 매 경기/매 플레이마다 다른 동선)
            let t = state.ticks;
            let seed = ((p.id || 'p').toString().split('').reduce((a, c) => a + c.charCodeAt(0), 0) + Math.floor(p.baseX * 1.3) + Math.floor(p.baseY)) % 997;
            let personalPhase = seed * 0.021 + (p.baseY % 17) * 0.11;
            // 다층 주파수 사인파 + 개인 위상으로 유기적이고 예측 불가능한 움직임 생성
            let v1 = Math.sin(t / 21 + personalPhase + p.baseY * 0.012) * 8.0;
            let v2 = Math.sin(t / 36 + personalPhase * 0.65 + p.baseX * 0.008) * 6.0;
            let v3 = Math.sin(t / 49 + personalPhase * 1.35) * 4.2;
            let defendJitter = v3 * 0.7;

            // ★ 스마트 다중 압박 + 루즈볼/세컨볼/빈공간 볼 강하게 탈취
            let isPressing = false;
            if (p.role !== 'GK') {
                if (rank === 0) isPressing = true;
                else if (rank <= 1 && (isFinalThirdDef || isLooseBall) && distToBall < 18) isPressing = true;
                else if (rank === 1 && distToBall < 9) isPressing = true;
                else if (rank === 2 && isLooseBall && distToBall < 15) isPressing = true; // 세컨볼/루즈볼 적극 추격
            }

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 2) + v3 * 0.25;
                targetY = Math.max(40, Math.min(60, state.ball.y + v2 * 0.15)); 
                if(distToBall < 10) { targetX = state.ball.x + v1 * 0.08; targetY = state.ball.y; }
            } 
            else if (isPressing) {
                targetX = state.ball.x + v1 * 0.12; targetY = state.ball.y + v2 * 0.08; 
            } 
            else if (attTeam === p.team) {
                // 공격 오프더볼: 다층 변칙 사인 + 상황별 의도(컷인/와이드)로 매번 다른 침투/스위칭
                if (p.role === 'DF') { 
                    targetX = Math.max(18, Math.min(82, state.ball.x - (dir * 15) + v1 * 0.35)); 
                    targetY = p.baseY + v1 * 0.55 + v2 * 0.35; 
                } 
                else if (p.role === 'MF') { 
                    targetX = Math.max(28, Math.min(72, state.ball.x + (dir * 9) + v2 * 0.45)); 
                    targetY = p.baseY + v1 * 1.1 + v3 * 0.9; 
                } 
                else if (p.role === 'FW') { 
                    // FW 공격 위치/타이밍 변주: 박스 안에서 컷인 or 스테이 와이드 → 슈팅 위치/각도 매번 다름
                    let inBox = (p.team === 1 && p.x > 74) || (p.team === 2 && p.x < 26);
                    let cutIntent = Math.sin(t / 17 + personalPhase) > -0.1; 
                    if (inBox && cutIntent) {
                        targetX = (p.team === 1) ? 91 + v2 * 0.7 : 9 - v2 * 0.7;
                        targetY = 50 + v1 * 1.6; // 중앙 컷인으로 다양한 슈팅 각도 유도
                    } else {
                        targetX = (p.team === 1) ? 84 + v1 * 1.1 : 16 - v1 * 1.1; 
                        targetY = p.baseY + v2 * 1.7 + (cutIntent ? v3 * 1.5 : -v3 * 0.8);
                    }
                }
            } 
            else {
                // 수비: CB가 가장 위협적인 공격수를 적극적으로 마킹 (중앙 공간 최소화)
                if (p.role === 'DF') { 
                    // 가장 위협적인 상대 (전진한 FW/MF) 탐색
                    let threat = null; let bestThreatScore = -Infinity;
                    state.players.forEach(op => {
                        if (op.team !== p.team && (op.role === 'FW' || (op.role === 'MF' && isFinalThirdDef))) {
                            let advanced = (p.team === 1 ? (100 - op.x) : op.x);
                            let central = 12 - Math.min(12, Math.abs(op.y - 50));
                            let distMe = getDistance(p.x, p.y, op.x, op.y);
                            let threatScore = advanced * 1.6 - distMe * 0.7 + central * 0.9;
                            if (threatScore > bestThreatScore) { bestThreatScore = threatScore; threat = op; }
                        }
                    });
                    if (threat && bestThreatScore > 4 && distToBall < 38) {
                        // 골키퍼 쪽(골사이드)에서 타이트 마킹 + 약간의 지터
                        targetX = Math.max(4, Math.min(96, threat.x - dir * (isFinalThirdDef ? 3.5 : 7) + defendJitter * 0.4));
                        targetY = threat.y * 0.62 + p.baseY * 0.38 + defendJitter * 0.6;
                    } else if (isFinalThirdDef) {
                        targetX = ownGoalX + (dir * 11) + defendJitter * 0.3;
                        targetY = p.baseY * 0.22 + 50 * 0.78 + defendJitter * 0.9; // 더 강한 중앙 압축
                    } else {
                        targetX = Math.max(10, Math.min(90, state.ball.x - (dir * 17) + defendJitter * 0.35)); 
                        targetY = p.baseY * 0.65 + state.ball.y * 0.35 + defendJitter * 0.6; // 중앙 커버 강화
                    }
                } 
                else if (p.role === 'MF') { 
                    if (isFinalThirdDef) {
                        targetX = ownGoalX + (dir * 20) + defendJitter * 0.4;
                        targetY = p.baseY * 0.38 + 50 * 0.62 + defendJitter;
                    } else {
                        targetX = state.ball.x - (dir * 7) + v2 * 0.25; targetY = p.baseY * 0.55 + state.ball.y * 0.45 + defendJitter; 
                    }
                } 
                else if (p.role === 'FW') { 
                    targetX = state.ball.x + (dir * 9) + v1 * 0.35; targetY = p.baseY + defendJitter * 0.65;
                }
            }

            // 동료와 겹치지 않도록 밀어내기 (약간의 랜덤으로 자연스러움 추가)
            state.players.forEach(mate => {
                if (mate !== p && mate.team === p.team && mate.role !== 'GK') {
                    let dM = getDistance(p.x, p.y, mate.x, mate.y);
                    if (dM < 11) { 
                        let push = (11.5 - dM) * 1.25;
                        targetX += (p.x - mate.x) / (dM || 1) * push + (Math.random() - 0.5) * 0.6;
                        targetY += (p.y - mate.y) / (dM || 1) * push + (Math.random() - 0.5) * 0.6;
                    }
                }
            });

            targetX = Math.max(3, Math.min(97, targetX));
            targetY = Math.max(3, Math.min(97, targetY));

            let baseSpeedFactor = (0.80 + Math.random() * 0.38);
            let moveSpeed = ((p.stats.spd || 80) / 100) * baseSpeedFactor; 
            if (isPressing) moveSpeed *= (isLooseBall ? 1.58 : 1.32); 
            
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            if (distToTarget > moveSpeed * 0.75) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 5. 터치 및 스마트 결정 로직 (슈팅 위치/타이밍/에임 완전 변칙화 + 루즈볼 대응 강화) ---
            let touchRadius = p.role === 'GK' ? 4 : 3; 
            let distToBallAct = getDistance(p.x, p.y, state.ball.x, state.ball.y);

            if (distToBallAct < touchRadius && p.cooldown === 0 && state.phase === 'play') { 
                state.lastTouchTeam = p.team;
                let targetGoalX = (p.team === 1) ? 100 : 0;
                let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);

                let enemyAhead = false;
                state.players.forEach(e => {
                    if (e.team !== p.team && e.role !== 'GK') {
                        let d = getDistance(p.x, p.y, e.x, e.y);
                        if (d < 11 && ((p.team === 1 && e.x > p.x) || (p.team === 2 && e.x < p.x))) { enemyAhead = true; }
                    }
                });

                // 슈팅 확률 계산 (위치/각도/스페이스에 따라 매번 다르게 결정)
                let shootProb = 0.38;
                let angleFactor = 0.55;
                if (distToGoal < 32) {
                    angleFactor = 1 - Math.min(1, Math.abs(p.y - 50) / 20);
                    let spaceFactor = enemyAhead ? 0.28 : 1.05;
                    shootProb = 0.42 + angleFactor * 0.37 + spaceFactor * 0.23;
                    if (shootProb > 0.93) shootProb = 0.93;
                }

                if (p.role === 'GK') {
                    let isInBox = Math.abs(p.x - ownGoalX) < 20 && p.y > 20 && p.y < 80;
                    if (isInBox) {
                        state.phase = 'gk_hold'; state.gkHolder = p; state.setPieceTimer = 15;
                        state.ball.vx = 0; state.ball.vy = 0; state.ball.x = p.x; state.ball.y = p.y;
                        state.eventText = "키퍼 선방!"; p.cooldown = 20;
                    } else {
                        io.to(roomCode).emit('playSound', 'kick');
                        state.ball.vx = dir * 6.0; state.ball.vy = (p.y > 50) ? 3.0 : -3.0; p.cooldown = 15;
                    }
                } 
                else if (distToGoal < 30 && Math.random() < shootProb && (!enemyAhead || Math.random() < 0.58)) {
                    // ★ 슈팅 변칙화: 에임 포인트(골대 내 랜덤), 파워 변동, 쿨타임 변동, 스웨이브
                    // → 매번 다른 위치/타이밍/각도로 슈팅. 가운데만 노리는 문제 해결
                    io.to(roomCode).emit('playSound', 'kick');
                    let power = (p.stats.sht || 85) / 14.2 * (0.87 + Math.random() * 0.26);
                    // 골대 안 다양한 지점 노림 (중앙/니어포스트/파포스트 랜덤)
                    let aimSpread = 9.5 + Math.random() * 9.5;
                    let aimY = 50 + (Math.random() - 0.5) * aimSpread * (0.7 + angleFactor * 0.6 || 0.8);
                    aimY = Math.max(38.5, Math.min(61.5, aimY));
                    let dx = targetGoalX - p.x;
                    let dy = aimY - p.y;
                    let d = Math.sqrt(dx * dx + dy * dy) || 1;
                    state.ball.vx = (dx / d) * power * (0.90 + Math.random() * 0.18);
                    state.ball.vy = (dy / d) * power * (0.88 + Math.random() * 0.22) + (Math.random() - 0.5) * 0.38;
                    p.cooldown = 7 + Math.floor(Math.random() * 6); // 7~12 틱 변동 (타이밍 다양화)
                } 
                else {
                    let isFinalThirdAtt = (p.team === 1 && p.x > 66) || (p.team === 2 && p.x < 34);
                    let isWinger = p.y < 25 || p.y > 75;

                    if (isFinalThirdAtt && isWinger && Math.random() < 0.58) {
                        let strikersInBox = state.players.filter(m => m.team === p.team && m !== p && Math.abs(m.y - 50) < 30 && m.role !== 'DF');
                        if (strikersInBox.length > 0) {
                            let target = strikersInBox[Math.floor(Math.random() * strikersInBox.length)];
                            io.to(roomCode).emit('playSound', 'kick');
                            let power = (p.stats.pas || 80) / 17.5;
                            let d = getDistance(p.x, p.y, target.x, target.y);
                            state.ball.vx = ((target.x - p.x) / d) * power;
                            state.ball.vy = ((target.y - p.y) / d) * power + (Math.random() - 0.5) * 0.6;
                            p.cooldown = 9 + Math.floor(Math.random() * 4); 
                            return; 
                        }
                    }

                    let bestMate = null; let maxScore = -999;
                    state.players.forEach(m => {
                        if (m.team === p.team && m !== p && m.role !== 'GK') {
                            let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x); 
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            
                            let visionCreativity = (Math.random() * 38) - 9;
                            let score = (forwardDist * 4) - dist + visionCreativity; 
                            
                            let enemyNearMate = false;
                            state.players.forEach(e => {
                                if (e.team !== p.team && getDistance(m.x, m.y, e.x, e.y) < 6) enemyNearMate = true;
                            });
                            
                            if (enemyNearMate) score -= 80;
                            if (dist < 5 || dist > 60) score -= 100; 

                            if (score > maxScore) { maxScore = score; bestMate = m; }
                        }
                    });

                    if ((enemyAhead || maxScore > 10) && bestMate) {
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = (p.stats.pas || 80) / 19.5; 
                        let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                        state.ball.vx = ((bestMate.x - p.x) / d) * power;
                        state.ball.vy = ((bestMate.y - p.y) / d) * power + (Math.random() - 0.5) * 0.25;
                        p.cooldown = 9 + Math.floor(Math.random() * 3); 
                    } 
                    else {
                        let dodgeY = (p.y > 50) ? -1 : 1;
                        if (enemyAhead) {
                            state.ball.vx = dir * 1.45;
                            state.ball.vy = dodgeY * 2.1; 
                        } else {
                            state.ball.vx = dir * 1.75;
                            state.ball.vy = (Math.random() - 0.5) * 0.55;
                        }
                        p.cooldown = 2;
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
