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
    state.eventText = "킥오프";
    state.setPieceTimer = 0;
    state.gkHolder = null;
    state.lastTouchTeam = kickoffTeam;
    state.possessionTeam = kickoffTeam;

    // 플레이어들을 기본 위치로 복귀 (간단 버전)
    state.players.forEach(p => {
        if (p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - 5);
        p.x = p.baseX;
        p.y = p.baseY;
    });

    // 킥오프 팀 스트라이커를 약간 앞으로
    const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW');
    if (striker) {
        striker.x = (kickoffTeam === 1) ? 55 : 45;
        striker.y = 50;
    }
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
                // [inference] 하드코딩된 0~9 대신 포메이션의 실제 키값을 기준으로 빈자리를 찾도록 수정
                const formationData = Array.isArray(db.formations) 
                    ? db.formations.find(f => f.id === pData.formation).positions 
                    : db.formations[pData.formation].positions;
                
                const allSlots = Object.keys(formationData); // 배열 인덱스 또는 객체의 문자열 키
                const filledSlots = pData.team.map(t => String(t.slot)); // 비교를 위해 전부 문자열 변환
                
                // 남은 슬롯 중 아직 채워지지 않은 첫 번째 빈자리 찾기
                const emptySlot = allSlots.find(slot => !filledSlots.includes(slot));
                
                if(emptySlot !== undefined) {
                    const assignedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
                    // 기존 데이터 타입 유지 (배열이면 정수로, 객체면 문자열로 저장)
                    const finalSlot = Array.isArray(formationData) ? parseInt(emptySlot) : emptySlot;
                    
                    pData.team.push({ slot: finalSlot, player: assignedPlayer });
                    io.to(pId).emit('autoPlaced', finalSlot, assignedPlayer); 
                }
                room.currentDraft.answers++;
                if(isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
            }
        });

        if (room.currentDraft.answers === 2) { 
            clearTimeout(room.draftTimeout); 
            room.draftCount++; 
            
            if (room.draftCount >= 10) {
                setTimeout(() => nextDraftTurn(roomCode), 1000);
            } else {
                nextDraftTurn(roomCode); 
            }
        }
    }, room.settings.timer * 1000 + 1000);
}

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode];
    room.state = 'match'; room.code = roomCode; 

    if (!db || !db.players || !db.formations || !db.settings) {
    console.error("🔥 database.json 로드 실패 또는 필수 필드 누락");
    process.exit(1);
    }
    
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]], p2Data = room.players[playerIds[1]];
        
        const p1Formation = Array.isArray(db.formations) 
            ? db.formations.find(f => f.id === p1Data.formation)?.positions 
            : db.formations[p1Data.formation]?.positions;
            
        const p2Formation = Array.isArray(db.formations) 
            ? db.formations.find(f => f.id === p2Data.formation)?.positions 
            : db.formations[p2Data.formation]?.positions;
            
        if (!p1Formation || !p2Formation) {
            console.error("🔥 포메이션 데이터를 읽어오지 못했습니다. 확인이 필요합니다.");
            return;
        }

        const gkStats = { spd: 85, sht: 85, pas: 80 }; 

        // [수정] t.slot의 인덱스 불일치 및 undefined 참조 완벽 방어
        const mapTeamPlayers = (teamData, formationPositions, teamId) => {
            return teamData.team.map((t, idx) => {
                // 문자열 혼합형 slot 방어용 정제 처리
                const cleanSlot = typeof t.slot === 'number' ? t.slot : parseInt(String(t.slot).replace(/[^0-9]/g, ''), 10);
                // 해당 슬롯 인덱스가 없으면 배열의 순서(idx)나 기본 객체로 대체
                const pos = formationPositions[cleanSlot] || formationPositions[idx] || { id: 'MF', x: 50, y: 50 };
                
                if (teamId === 1) {
                    return { ...t.player, team: 1, role: getRole(pos.id), posId: pos.id, x: pos.x / 2, y: pos.y, baseX: pos.x / 2, baseY: pos.y, cooldown: 0 };
                } else {
                    return { ...t.player, team: 2, role: getRole(pos.id), posId: pos.id, x: 100 - (pos.x / 2), y: 100 - pos.y, baseX: 100 - (pos.x / 2), baseY: 100 - pos.y, cooldown: 0 };
                }
            });
        };

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, 
            phase: 'play', setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이", isPaused: false, throwerId: null, gkHolder: null,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...mapTeamPlayers(p1Data, p1Formation, 1),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats, cooldown: 0 },
                ...mapTeamPlayers(p2Data, p2Formation, 2),
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

        // --- 4. ★ 완벽한 지역 방어, 루즈볼 탈취 및 변칙적 오프더볼 AI ---
        // 루즈볼 상태 판별 (누구의 소유도 아닐 때)
        let isLooseBall = (minDist1 > 6 && minDist2 > 6);

        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;
            let targetX = p.baseX, targetY = p.baseY;
            let dir = (p.team === 1) ? 1 : -1; 
            let ownGoalX = (p.team === 1) ? 0 : 100;
            
            let myDistArr = (p.team === 1) ? distArr1 : distArr2;
            let rankObj = myDistArr.find(obj => obj.p === p);
            let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
            let distToBall = rankObj ? rankObj.dist : 999;

            let isFinalThirdDef = getDistance(state.ball.x, state.ball.y, ownGoalX, 50) < 35;

            // ★ 매 공격/수비마다 완전히 다른 그림을 만드는 다중 위상 난수
            // 선수의 이름(ID) 길이, 고유 번호, 현재 틱을 조합해 예측 불가능한 변수 생성
            let playerEntropy = (p.id ? p.id.charCodeAt(0) : 1);
            let chaosFactorX = Math.sin(state.ticks / (15 + playerEntropy % 10)) * 8;
            let chaosFactorY = Math.cos(state.ticks / (10 + playerEntropy % 5)) * 8;

            // ★ 적극적인 압박 및 센터백의 헌신적 수비
            let isPressing = false;
            let isChasingLooseBall = false;

            if (p.role !== 'GK') {
                if (rank === 0) isPressing = true;
                
                // 루즈볼 상황: 양 팀에서 가장 가까운 선수는 공의 미래 궤적을 향해 미친듯이 달려감
                if (isLooseBall && rank === 0 && distToBall < 25) {
                    isChasingLooseBall = true;
                }

                // 중앙 수비수(CB)의 적극성 대폭 강화 (중앙을 내주지 않음)
                if (p.role === 'DF' && Math.abs(p.baseY - 50) < 25) { 
                    // 위험 지역 중앙에 공이 들어오면 수비 라인을 버리고 즉시 덤빔
                    if (isFinalThirdDef && Math.abs(state.ball.y - 50) < 25 && distToBall < 18) {
                        isPressing = true;
                    }
                }
                
                // 협력 수비 난수화 (때로는 2명이, 때로는 3명이 에워쌈)
                if (rank === 1 && distToBall < (8 + Math.random() * 5)) isPressing = true;
            }

            if (p.role === 'GK') {
                targetX = ownGoalX + (dir * 2);
                targetY = Math.max(42, Math.min(58, state.ball.y)); 
                if (distToBall < 10) { targetX = state.ball.x; targetY = state.ball.y; }
            } 
            else if (isChasingLooseBall) {
                // 공이 굴러가는 궤적(vx, vy)을 예측하여 앞질러 달려감
                targetX = state.ball.x + state.ball.vx * 3;
                targetY = state.ball.y + state.ball.vy * 3;
            }
            else if (isPressing) {
                targetX = state.ball.x; 
                targetY = state.ball.y; 
            } 
            else if (attTeam === p.team) {
                // 공격 시 오프더볼: chaosFactor를 더해 매번 완전히 다른 루트로 침투
                if (p.role === 'DF') { 
                    targetX = Math.max(25, Math.min(75, state.ball.x - (dir * 15))) + chaosFactorX; 
                    targetY = p.baseY + chaosFactorY; 
                } 
                else if (p.role === 'MF') { 
                    targetX = Math.max(35, Math.min(65, state.ball.x + (dir * 12))) + chaosFactorX; 
                    targetY = p.baseY + chaosFactorY * 1.5; 
                } 
                else if (p.role === 'FW') { 
                    targetX = ((p.team === 1) ? 88 : 12) + chaosFactorX * 1.2; 
                    targetY = p.baseY + chaosFactorY * 1.5; 
                }
            } 
            else {
                // 수비 시 오프더볼: 정적인 라인 유지가 아니라 공의 위치와 난수에 따라 유동적으로 막음
                if (p.role === 'DF') { 
                    if (isFinalThirdDef) {
                        targetX = ownGoalX + (dir * (12 + Math.random() * 5)); // 라인 높이도 변칙적
                        targetY = p.baseY * 0.3 + state.ball.y * 0.7; // 중앙 고정이 아닌 공을 향해 좁힘
                    } else {
                        targetX = Math.max(15, Math.min(85, state.ball.x - (dir * (15 + chaosFactorX)))); 
                        targetY = p.baseY + chaosFactorY * 0.5; 
                    }
                } 
                else if (p.role === 'MF') { 
                    if (isFinalThirdDef) {
                        targetX = ownGoalX + (dir * (22 + chaosFactorX));
                        targetY = p.baseY * 0.4 + state.ball.y * 0.6;
                    } else {
                        targetX = state.ball.x - (dir * (10 + chaosFactorX)); 
                        targetY = p.baseY + chaosFactorY; 
                    }
                } 
                else if (p.role === 'FW') { 
                    targetX = state.ball.x + (dir * 15) + chaosFactorX; 
                    targetY = p.baseY + chaosFactorY;
                }
            }

            // 동료와 겹치지 않도록 밀어내기
            state.players.forEach(mate => {
                if (mate !== p && mate.team === p.team && mate.role !== 'GK') {
                    if (getDistance(p.x, p.y, mate.x, mate.y) < 10) { 
                        targetX += (p.x - mate.x) * 1.5; targetY += (p.y - mate.y) * 1.5;
                    }
                }
            });

            targetX = Math.max(3, Math.min(97, targetX));
            targetY = Math.max(3, Math.min(97, targetY));

            let moveSpeed = ((p.stats.spd || 80) / 100) * (0.85 + Math.random() * 0.3); 
            
            // 압박 시 또는 루즈볼을 향해 달려갈 때 속도 극대화 (더 강한 투지)
            if (isChasingLooseBall) moveSpeed *= 1.6;
            else if (isPressing) moveSpeed *= 1.4; 
            
            let distToTarget = getDistance(p.x, p.y, targetX, targetY);
            if (distToTarget > moveSpeed) {
                p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
            }

            // --- 5. 터치 및 스마트 결정 로직 (변칙 슈팅 포함) ---
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
                        if (d < 12 && ((p.team === 1 && e.x > p.x) || (p.team === 2 && e.x < p.x))) { enemyAhead = true; }
                    }
                });

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
                else {
                    // 슈팅 타이밍 난수화
                    let dynamicShootThreshold = 20 + Math.random() * 15; 
                    
                    if (distToGoal < dynamicShootThreshold && (!enemyAhead || Math.random() < 0.4)) {
                        io.to(roomCode).emit('playSound', 'kick');
                        
                        let power = ((p.stats.sht || 85) / 15) * (0.9 + Math.random() * 0.3); 
                        
                        // [addition] 지능적 파포스트 역산 AI
                        let enemyGk = state.players.find(e => e.team !== p.team && e.role === 'GK');
                        let cornerAimY = 50; // 기본 중앙
                        
                        if (enemyGk) {
                            // 골키퍼가 Y축 중앙(50)을 기준으로 어디로 치우쳐 있는지 역산
                            if (enemyGk.y > 52) {
                                // 키퍼가 아래쪽으로 쏠려 있으면 위쪽 구석(42~46)을 노림
                                cornerAimY = 42 + Math.random() * 4; 
                            } else if (enemyGk.y < 48) {
                                // 키퍼가 위쪽으로 쏠려 있으면 아래쪽 구석(54~58)을 노림
                                cornerAimY = 54 + Math.random() * 4; 
                            } else {
                                // 정중앙을 지키고 있다면 랜덤하게 양옆 구석 중 하나를 찌름
                                cornerAimY = 50 + (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 3); 
                            }
                        }

                        // 초장거리 슈팅일 경우 거리에 비례하여 궤적이 흔들리도록 페널티 부여
                        if (distToGoal > 28) cornerAimY += (Math.random() - 0.5) * 8; 

                        state.ball.vx = ((targetGoalX - p.x) / distToGoal) * power;
                        state.ball.vy = ((cornerAimY - p.y) / distToGoal) * power;
                        p.cooldown = 12; // 슈팅 후 딜레이
                    }
                    else {
                        let isFinalThirdAtt = (p.team === 1 && p.x > 66) || (p.team === 2 && p.x < 34);
                        let isWinger = p.y < 25 || p.y > 75;

                        // 크로스 로직
                        if (isFinalThirdAtt && isWinger && Math.random() < 0.6) {
                            let strikersInBox = state.players.filter(m => m.team === p.team && m !== p && Math.abs(m.y - 50) < 30 && m.role !== 'DF');
                            if (strikersInBox.length > 0) {
                                let target = strikersInBox[Math.floor(Math.random() * strikersInBox.length)];
                                io.to(roomCode).emit('playSound', 'kick');
                                let power = (p.stats.pas || 80) / 18;
                                let d = getDistance(p.x, p.y, target.x, target.y);
                                state.ball.vx = ((target.x - p.x) / d) * power;
                                state.ball.vy = ((target.y - p.y) / d) * power;
                                p.cooldown = 10; 
                                return; 
                            }
                        }

                        // 패스 로직
                        let bestMate = null; let maxScore = -999;
                        state.players.forEach(m => {
                            if (m.team === p.team && m !== p && m.role !== 'GK') {
                                let forwardDist = (p.team === 1) ? (m.x - p.x) : (p.x - m.x); 
                                let dist = getDistance(p.x, p.y, m.x, m.y);
                                
                                let visionCreativity = (Math.random() * 50) - 20; // 패스 창의성 폭 극대화
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

                        if ((enemyAhead || maxScore > 15) && bestMate) {
                            io.to(roomCode).emit('playSound', 'kick');
                            let power = ((p.stats.pas || 80) / 20) * (0.9 + Math.random() * 0.2); 
                            let d = getDistance(p.x, p.y, bestMate.x, bestMate.y);
                            
                            state.ball.vx = ((bestMate.x - p.x) / d) * power;
                            state.ball.vy = ((bestMate.y - p.y) / d) * power;
                            p.cooldown = 10; 
                        } 
                        else {
                            // 드리블 시 빈 공간 치달 (이전 수정안 유지)
                            let dodgeY = (p.y > 50) ? -1 : 1;
                            if (enemyAhead) { 
                                state.ball.vx = dir * 1.5;
                                state.ball.vy = dodgeY * 2.5; // 좀 더 과감하게 꺾기
                            } else { 
                                state.ball.vx = dir * 1.8;
                                state.ball.vy = (Math.random() - 0.5) * 1.0; 
                            }
                            p.cooldown = 2; // 드리블 중 공을 뺏기지 않도록 쿨타임 최소화
                        }
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
