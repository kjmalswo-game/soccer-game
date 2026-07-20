const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let db;
try { 
    db = JSON.parse(fs.readFileSync('database.json', 'utf8')); 
} catch(e) { 
    console.error("🔥 database.json 파일 문법 에러!:", e); 
}

const rooms = {};
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// --- 헬퍼 함수 ---
function getDistance(x1, y1, x2, y2) { 
    let d = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); 
    return isNaN(d) ? 1 : d; 
}

function pDistance(x, y, x1, y1, x2, y2) {
    let A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
    let dot = A * C + B * D;
    let len_sq = C * C + D * D;
    let param = -1;
    if (len_sq !== 0) param = dot / len_sq;
    else return Math.sqrt(A*A + B*B) || 999; 
    let xx, yy;
    if (param < 0) { xx = x1; yy = y1; } 
    else if (param > 1) { xx = x2; yy = y2; } 
    else { xx = x1 + param * C; yy = y1 + param * D; }
    let dx = x - xx, dy = y - yy;
    let d = Math.sqrt(dx * dx + dy * dy);
    return isNaN(d) ? 999 : d;
}

function getRole(posId) {
    if (!posId) return 'MF';
    if (posId.includes('B')) return 'DF'; 
    const fwList = ['ST', 'LS', 'RS', 'CF', 'LF', 'RF', 'LW', 'RW'];
    if (fwList.includes(posId) || posId.includes('T') || posId.includes('W')) return 'FW'; 
    return 'MF'; 
}

function resetPositions(state, kickoffTeam) {
    state.ball = { x: 50, y: 50, vx: 0, vy: 0, airTicks: 0, shotTicks: 0 };
    state.phase = 'play';
    state.isPaused = false;
    state.setPieceTimer = 0; // ★ 하프타임 킥오프 먹통 해결의 핵심 키!
    state.isKickoff = true;
    state.kickoffTeam = kickoffTeam;
    state.passTargetId = null; 
    state.lastPasserId = null; 
    state.lastTeam1Touch = null; // 🎯 팀1 마지막 터치 추적용
    state.lastTeam2Touch = null; // 🎯 팀2 마지막 터치 추적용
    state.gkHolder = null;
    state.throwerId = null;
    state.kickerId = null;

    state.players.forEach(p => { 
        p.x = p.baseX; 
        p.y = p.baseY; 
        p.cooldown = 0; 
        p.duelCooldown = 0; 
    });
    
    // 후반전 대응 방향 설정
    let leftTeam = state.half === 1 ? 1 : 2;
    const striker = state.players.find(p => p.team === kickoffTeam && p.role === 'FW') || state.players.find(p => p.team === kickoffTeam && p.role !== 'GK');
    if (striker) { 
        striker.x = kickoffTeam === leftTeam ? 47 : 53; 
        striker.y = 50; 
        state.kickoffStrikerId = striker.id;
    } else {
        state.kickoffStrikerId = null;
    }
}
function emitUpdate(roomCode, state) {
    let totalTicks = state.ticks;
    let gameSeconds = (totalTicks / 10) * (db.settings.gameMinutesPerHalf * 60 / db.settings.halfDurationRealSeconds);
    if (state.half === 2) gameSeconds += db.settings.gameMinutesPerHalf * 60; 
    io.to(roomCode).emit('matchUpdate', {
        gameSeconds: gameSeconds, event: state.eventText, ball: state.ball, players: state.players, score: state.score,
        goalLog: state.goalLog || [] 
    });
}

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = { 
            players: { [socket.id]: { id: 'player1', ready: false, team: [] } }, 
            // 🎯 settings에 halfTimeDuration: 15 추가
            settings: { timer: db.settings.draftTimers[1], skips: 0, halfTimeDuration: 15, formation: null }, 
            state: 'lobby', 
            availablePlayers: JSON.parse(JSON.stringify(db.players))
        };
        socket.join(roomCode); 
        socket.emit('roomCreated', roomCode, db);
    });

    socket.on('joinRoom', (roomCode) => {
        // 🎯 000(랜덤 즉시 시작)과 111(드래프트 즉시 시작) 모두 테스트 방 생성 처리
        if (roomCode === '000' || roomCode === '111') {
            const formationKeys = Object.keys(db.formations);
            const randomAiFormation = formationKeys[Math.floor(Math.random() * formationKeys.length)];
            
            const testRoomCode = (roomCode === '000' ? 'TEST000_' : 'TEST111_') + generateRoomCode(); 
            rooms[testRoomCode] = {
                players: {
                    'dummy_ai': { id: 'player1', ready: true, team: [], formation: randomAiFormation },
                    [socket.id]: { id: 'player2', ready: false, team: [], formation: null }
                },
                // 🎯 111 모드에서는 스킵 기능도 원활히 테스트할 수 있도록 기본적으로 스킵 3회를 부여합니다!
                settings: { timer: db.settings.draftTimers[1], skips: (roomCode === '111' ? 3 : 0), halfTimeDuration: 15, formation: null },
                state: 'lobby',
                availablePlayers: JSON.parse(JSON.stringify(db.players)),
                isTestMode: roomCode === '000', // 000 모드는 드래프트 몽땅 생략 플래그
                isDraftTestMode: roomCode === '111' // 111 모드는 혼자 드래프트 진행 플래그
            };
            socket.join(testRoomCode);
            socket.emit('roomJoined', testRoomCode, db); 
            setTimeout(() => { io.to(testRoomCode).emit('playerJoinedLobby'); }, 500); 
            return;
        }

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
    // 🎯 방장이 스킵 횟수를 변경할 때 받는 이벤트 추가
    socket.on('setSkips', (roomCode, skipsValue) => {
        if (rooms[roomCode]) {
            rooms[roomCode].settings.skips = parseInt(skipsValue);
        }
    });

    // 🎯 방장이 하프타임 시간을 변경할 때 받는 이벤트
    socket.on('setHalfTime', (roomCode, timeValue) => {
        if (rooms[roomCode]) {
            rooms[roomCode].settings.halfTimeDuration = parseInt(timeValue);
        }
    });

    socket.on('playerReady', (roomCode, formationId) => {
        const room = rooms[roomCode]; 
        if(!room || !room.players[socket.id]) return; 
        room.players[socket.id].formation = formationId; 
        room.players[socket.id].ready = true;
        const playersArr = Object.values(room.players);
        
        if (playersArr.every(p => p.ready) && playersArr.length === 2) {
            if (room.isTestMode) {
                playersArr.forEach(pData => {
                    for (let i = 0; i < 10; i++) {
                        if (room.availablePlayers.length === 0) break;
                        let idx = Math.floor(Math.random() * room.availablePlayers.length);
                        pData.team.push({ slot: i, player: room.availablePlayers.splice(idx, 1)[0] });
                    }
                });
                startMatchPhase(roomCode, false);
            } else {
                startDraftPhase(roomCode);
            }
        }
    });

    socket.on('playerPlaced', (roomCode, slotId, playerInfo) => {
        const room = rooms[roomCode]; 
        if(!room || !room.currentDraft) return;
        const isP1 = room.players[socket.id].id === 'player1';
        const expectedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
        if (!playerInfo || playerInfo.id !== expectedPlayer.id || (isP1 && room.currentDraft.p1Placed) || (!isP1 && room.currentDraft.p2Placed)) return;
        room.players[socket.id].team.push({ slot: slotId, player: playerInfo });
        room.currentDraft.answers++;
        if (isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
        if (room.currentDraft.answers === 2) { 
            clearTimeout(room.draftTimeout); 
            room.draftCount++; 
            nextDraftTurn(roomCode); 
        }
    });

    socket.on('skipPlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || !room.currentDraft || room.state !== 'draft') return;
        
        const pData = room.players[socket.id];
        if (!pData) return;

        const isP1 = pData.id === 'player1';
        const hasPlaced = isP1 ? room.currentDraft.p1Placed : room.currentDraft.p2Placed;

        // 이미 선수를 배치했거나, 남은 스킵 횟수가 없으면 무시
        if (hasPlaced || pData.skipsLeft <= 0) return;

        // 스킵 횟수 차감
        pData.skipsLeft--;

        // 새로운 선수 뽑기
        function pullRandomPlayer() {
            if(room.availablePlayers.length === 0) return null;
            const idx = Math.floor(Math.random() * room.availablePlayers.length);
            return room.availablePlayers.splice(idx, 1)[0];
        }
        const newPlayer = pullRandomPlayer();
        if (!newPlayer) return;

        // 현재 턴의 내 선수 데이터를 교체 (나중에 playerPlaced에서 검증할 때 쓰임)
        if (isP1) room.currentDraft.p1 = newPlayer;
        else room.currentDraft.p2 = newPlayer;

        // 방 전체가 아닌, '스킵을 누른 해당 플레이어'에게만 새로운 선수를 전송
        socket.emit('draftPlayerSkipped', {
            player: newPlayer,
            skipsLeft: pData.skipsLeft,
            skipsTotal: room.settings.skips
        });
    });

    socket.on('swapPlayers', (roomCode, teamId, id1, id2) => {
        const room = rooms[roomCode]; 
        if(!room || !room.matchState) return;
        const p1 = room.matchState.players.find(p => p.team === teamId && p.id == id1);
        const p2 = room.matchState.players.find(p => p.team === teamId && p.id == id2);
        if(p1 && p2) {
            let tempX = p1.baseX, tempY = p1.baseY, tempRole = p1.role, tempPosId = p1.posId;
            p1.baseX = p2.baseX; p1.baseY = p2.baseY; p1.role = p2.role; p1.posId = p2.posId; p1.x = p1.baseX; p1.y = p1.baseY;
            p2.baseX = tempX; p2.baseY = tempY; p2.role = tempRole; p2.posId = tempPosId; p2.x = p2.baseX; p2.y = p2.baseY;
        }
    });

    socket.on('changeFormation', (roomCode, teamId, formationId) => {
        const room = rooms[roomCode];
        if (!room || !room.matchState || !db.formations[formationId]) return;

        let state = room.matchState;
        // 새로운 포메이션의 좌표값 가져오기
        let positions = JSON.parse(JSON.stringify(db.formations[formationId].positions));
        let teamPlayers = state.players.filter(p => p.team === teamId && p.role !== 'GK');
        
        // 각 팀의 진영 방향에 맞게 목표 좌표 설정
        let targetCoords = positions.map(pos => {
            // 🎯 버그 수정: 매치 구장(절반) 비율에 맞게 pos.x를 2로 나눠주어야 화면을 뚫고 날아가지 않습니다!
            let bx = (teamId === 1) ? pos.x / 2 : 100 - (pos.x / 2);
            let by = (teamId === 1) ? pos.y : 100 - pos.y;
            return { id: pos.id, x: bx, y: by, assigned: false };
        });

        // 1. 모든 선수와 모든 새 자리 사이의 거리(Dist) 계산
        let pairs = [];
        teamPlayers.forEach(p => {
            targetCoords.forEach((t, tIndex) => {
                let dist = Math.sqrt(Math.pow(p.baseX - t.x, 2) + Math.pow(p.baseY - t.y, 2));
                pairs.push({ player: p, targetIndex: tIndex, dist: dist });
            });
        });

        // 2. 거리가 가장 짧은 순서대로 정렬
        pairs.sort((a, b) => a.dist - b.dist);

        // 3. 가장 가까운 자리부터 중복 없이 차례대로 선수 배정 (자동 매핑 알고리즘)
        let assignedIds = new Set();
        pairs.forEach(pair => {
            let t = targetCoords[pair.targetIndex];
            // 아직 자리를 못 잡은 선수이고, 빈자리일 경우 배정
            if (!assignedIds.has(pair.player.id) && !t.assigned) {
                pair.player.baseX = t.x;
                pair.player.baseY = t.y;
                pair.player.posId = t.id; // 포지션 이름(CB, ST 등) 변경
                
                // 바뀐 위치에 맞춰서 AI 롤(수비수, 미드필더, 공격수)도 업데이트
                if (t.id.includes('B')) pair.player.role = 'DF';
                else if (t.id.includes('M')) pair.player.role = 'MF';
                else if (t.id.includes('S') || t.id.includes('W') || t.id.includes('F')) pair.player.role = 'FW';

                assignedIds.add(pair.player.id);
                t.assigned = true;
            }
        });

        // 바뀐 위치 데이터를 해당 방의 클라이언트들에게 즉시 전송
        io.to(roomCode).emit('formationUpdated', teamId, state.players);
    });

    socket.on('returnToLobby', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        // 이미 로비로 돌아간 상태가 아닐 때만 1회 처리 (중복 방지)
        if (room.state !== 'lobby') {
            room.state = 'lobby';
            room.draftCount = 0;
            room.availablePlayers = [...db.players]; // 선수풀 100명 원상복구
            
            delete room.matchState;
            delete room.currentDraft;
            if (room.matchInterval) clearInterval(room.matchInterval);
            if (room.draftTimeout) clearTimeout(room.draftTimeout);

            // 각 플레이어의 준비 상태와 소유 팀 데이터 초기화
            Object.keys(room.players).forEach(key => {
                let p = room.players[key];
                
                if (key === 'dummy_ai') {
                    p.ready = true; // 🤖 000, 111 모드의 AI는 늘 준비 완료 상태 유지
                    // 다음 판을 위해 AI의 포메이션을 새롭게 랜덤 부여!
                    const formationKeys = Object.keys(db.formations);
                    p.formation = formationKeys[Math.floor(Math.random() * formationKeys.length)];
                } else {
                    p.ready = false; 
                }
                
                p.team = []; // 뽑았던 선수들 몰수
            });
            
            // 방 안에 있는 두 명 모두에게 로비 화면으로 돌아가라고 핑 발송
            io.to(roomCode).emit('returnedToLobby');
        }
    });

    socket.on('togglePause', (roomCode) => {
        const room = rooms[roomCode];
        if (room && room.matchState && (room.isTestMode || room.isDraftTestMode)) {
            // ★ 방어막: 골 세리머니(세팅 대기) 중일 때는 일시정지/재개 조작 자체를 무시함!
            if (room.matchState.phase === 'goal') return; 

            room.matchState.isPaused = !room.matchState.isPaused;
            io.to(roomCode).emit('pauseToggled', room.matchState.isPaused);
        }
    });
    
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.players[socket.id]) {
                if (room.matchInterval) clearInterval(room.matchInterval);
                if (room.draftTimeout) clearTimeout(room.draftTimeout);
                socket.to(roomCode).emit('error', '상대방과의 연결이 끊어져 방이 소멸되었습니다.');
                delete rooms[roomCode];
            }
        }
    });
});
function startDraftPhase(roomCode) {
    const room = rooms[roomCode]; 
    room.state = 'draft'; 
    room.draftCount = 0;
    
    // 🎯 드래프트 시작 시 설정된 스킵 횟수를 각 플레이어에게 초기화 부여
    Object.values(room.players).forEach(p => {
        p.skipsLeft = room.settings.skips || 0;
    });

    io.to(roomCode).emit('startDraft'); 
    nextDraftTurn(roomCode);
}

function nextDraftTurn(roomCode) {
    const room = rooms[roomCode];
    if (room.draftCount >= 10 || room.availablePlayers.length < 2) { 
        startMatchPhase(roomCode, false); 
        return; 
    }
    
    function pullRandomPlayer() {
        if(room.availablePlayers.length === 0) return null;
        const idx = Math.floor(Math.random() * room.availablePlayers.length);
        return room.availablePlayers.splice(idx, 1)[0];
    }
    
    const p1Player = pullRandomPlayer(), p2Player = pullRandomPlayer();
    room.currentDraft = { p1: p1Player, p2: p2Player, answers: 0, p1Placed: false, p2Placed: false };
    
    // 🎯 [111 모드 핵심] 상대방(AI)은 카드가 뽑히자마자 0초 만에 자기 진영 빈자리에 조용히 꽂아 넣고 대기합니다.
    // 따라서 유저가 카드를 선택하는 즉시 턴이 넘어가게 됩니다!
    if (room.isDraftTestMode) {
        const aiId = Object.keys(room.players).find(id => room.players[id].id === 'player1');
        const aiData = room.players[aiId];
        if (aiData) {
            const filledSlots = aiData.team.map(t => parseInt(t.slot));
            let emptySlot = -1;
            for(let i = 0; i < 10; i++) { 
                if(!filledSlots.includes(i)) { emptySlot = i; break; } 
            }
            if(emptySlot !== -1 && p1Player) {
                aiData.team.push({ slot: emptySlot, player: p1Player });
            }
            room.currentDraft.p1Placed = true;
            room.currentDraft.answers++;
        }
    }

    // 🎯 양 팀의 현재 남은 스킵 횟수를 함께 전송
    const pIds = Object.keys(room.players);
    const p1Id = pIds.find(id => room.players[id].id === 'player1');
    const p2Id = pIds.find(id => room.players[id].id === 'player2');
    
    io.to(roomCode).emit('draftPlayer', { 
        p1: p1Player, 
        p2: p2Player, 
        p1Skips: p1Id ? room.players[p1Id].skipsLeft : 0,
        p2Skips: p2Id ? room.players[p2Id].skipsLeft : 0,
        skipsTotal: room.settings.skips || 0,
        timeLimit: room.settings.timer 
    });
    
    const currentTurn = room.draftCount; 
    room.draftTimeout = setTimeout(() => { 
        if(!room || !room.currentDraft || room.draftCount !== currentTurn) return;
        Object.keys(room.players).forEach(pId => {
            const pData = room.players[pId]; 
            const isP1 = pData.id === 'player1';
            const hasPlaced = isP1 ? room.currentDraft.p1Placed : room.currentDraft.p2Placed;
            if (!hasPlaced) {
                const filledSlots = pData.team.map(t => parseInt(t.slot)); 
                let emptySlot = -1;
                for(let i = 0; i < 10; i++) { 
                    if(!filledSlots.includes(i)) { emptySlot = i; break; } 
                }
                if(emptySlot !== -1) {
                    const assignedPlayer = isP1 ? room.currentDraft.p1 : room.currentDraft.p2;
                    pData.team.push({ slot: emptySlot, player: assignedPlayer });
                    io.to(pId).emit('autoPlaced', emptySlot, assignedPlayer); 
                }
                room.currentDraft.answers++;
                if(isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
            }
        });
        if (room.currentDraft.answers >= 2) { 
            room.draftCount++; 
            nextDraftTurn(roomCode); 
        }
    }, room.settings.timer * 1000 + 500); 
}

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode]; 
    room.state = 'match'; 
    room.code = roomCode; 
    
    if (!isSecondHalf) {
        const playerIds = Object.keys(room.players);
        const p1Id = playerIds.find(id => room.players[id].id === 'player1');
        const p2Id = playerIds.find(id => room.players[id].id === 'player2');
        const p1Data = room.players[p1Id], p2Data = room.players[p2Id];
        const p1Formation = db.formations[p1Data.formation].positions, p2Formation = db.formations[p2Data.formation].positions;
        const gkStats = { spd: 85, sht: 85, pas: 85, def: 85 };

        room.matchState = {
            ticks: 0, half: 1, score: { team1: 0, team2: 0 }, 
            phase: 'play', setPieceTimer: 0, lastTouchTeam: 1, possessionTeam: 1, eventText: "오픈 플레이", isPaused: false, throwerId: null, kickerId: null, gkHolder: null, passTargetId: null,
            lastPasserId: null,
            ball: { x: 50, y: 50, vx: 0, vy: 0 },
            players: [
                ...p1Data.team.map((t, idx) => { 
                    return { ...t.player, team: 1, role: getRole(p1Formation[t.slot].id), posId: p1Formation[t.slot].id, x: p1Formation[t.slot].x / 2, y: p1Formation[t.slot].y, baseX: p1Formation[t.slot].x / 2, baseY: p1Formation[t.slot].y, cooldown: 0, duelCooldown: 0 }; 
                }),
                { id: 'gk1', name: 'GK', team: 1, role: 'GK', posId:'GK', x: 2, y: 50, baseX: 2, baseY: 50, stats: gkStats, cooldown: 0, duelCooldown: 0 },
                ...p2Data.team.map((t, idx) => { 
                    return { ...t.player, team: 2, role: getRole(p2Formation[t.slot].id), posId: p2Formation[t.slot].id, x: 100 - (p2Formation[t.slot].x / 2), y: 100 - p2Formation[t.slot].y, baseX: 100 - (p2Formation[t.slot].x / 2), baseY: 100 - p2Formation[t.slot].y, cooldown: 0, duelCooldown: 0 }; 
                }),
                { id: 'gk2', name: 'GK', team: 2, role: 'GK', posId:'GK', x: 98, y: 50, baseX: 98, baseY: 50, stats: gkStats, cooldown: 0, duelCooldown: 0 }
            ]
        };
    } else {
        room.matchState.half = 2; 
        room.matchState.ticks = 0; 
        room.matchState.phase = 'play'; 
        room.matchState.isPaused = false; 
        room.matchState.passTargetId = null;
        room.matchState.lastPasserId = null;
        room.matchState.players.forEach(p => {
            p.baseX = 100 - p.baseX;
            p.baseY = 100 - p.baseY;
        });
    }

    resetPositions(room.matchState, isSecondHalf ? 2 : 1);  
    io.to(roomCode).emit('matchStarted', room.matchState); 
    io.to(roomCode).emit('playSound', 'whistle');

    room.matchInterval = setInterval(() => {
        try {
            const state = room.matchState;
            if (state.isPaused) return; 
            state.ticks++;

            // ★ 후반전 진영 교체 대응 기준 변수 (가장 중요)
            let leftTeam = state.half === 1 ? 1 : 2;
            let rightTeam = state.half === 1 ? 2 : 1;

            // 0. 하프타임 및 풀타임 로직
            let halfSeconds = (db.settings.gameMinutesPerHalf * 60); 
            let currentSeconds = (state.ticks / 10) * (halfSeconds / db.settings.halfDurationRealSeconds);
            
            if (currentSeconds >= halfSeconds) {
                clearInterval(room.matchInterval);
                if (state.half === 1) {
                    startHalfTime(roomCode);
                } else {
                    // 🚨 [수정 완료] 경기 종료 시 빈 스코어만 보내는 게 아니라 득점 기록도 보냅니다.
                    io.to(roomCode).emit('matchEnded', { score: state.score, goalLog: state.goalLog || [] });
                    io.to(roomCode).emit('playSound', 'whistle');
                }
                return;
            }

            if (isNaN(state.ball.x) || isNaN(state.ball.y)) { state.ball.x = 50; state.ball.y = 50; state.ball.vx = 0; state.ball.vy = 0; }
            state.players.forEach(p => {
                if (isNaN(p.x) || isNaN(p.y)) { p.x = p.baseX; p.y = p.baseY; }
                if (isNaN(p.cooldown)) p.cooldown = 0;
                if (isNaN(p.duelCooldown)) p.duelCooldown = 0;
                if (isNaN(p.stunTicks)) p.stunTicks = 0;
            });

            // --- 1. 세트피스 처리 ---
            if (state.phase !== 'play') {
                if (state.phase === 'gk_hold' && state.gkHolder) {
                    state.ball.x = state.gkHolder.x + (state.gkHolder.team === leftTeam ? 1.5 : -1.5); 
                    state.ball.y = state.gkHolder.y; state.ball.vx = 0; state.ball.vy = 0;
                }

                state.setPieceTimer--;
                if (state.setPieceTimer <= 0) {
                    io.to(roomCode).emit('playSound', 'kick');
                    
                    if (state.phase === 'gk_hold' && state.gkHolder) {
                        let p = state.gkHolder;
                        let bestMate = null; let maxScore = -999;
                        let dir = (p.team === leftTeam) ? 1 : -1;
                        
                        state.players.forEach(m => {
                            if (m.team === p.team && m.role !== 'GK') {
                                let minEnemyDist = Infinity;
                                state.players.forEach(e => { if (e.team !== p.team) { let d = getDistance(m.x, m.y, e.x, e.y); if(d < minEnemyDist) minEnemyDist = d; } });
                                
                                let forwardDist = (p.team === leftTeam) ? (m.x - p.x) : (p.x - m.x);
                                
                                // 🎯 키퍼가 뒤에 있는 동료에게 던져서 코너킥이나 자책골이 나오는 것을 원천 차단합니다!
                                // 무조건 키퍼보다 앞쪽(forwardDist > 5)에 있는 동료에게만 패스하도록 락을 겁니다.
                                if (forwardDist > 5) {
                                    let score = minEnemyDist * 10; 
                                    if (m.y < 20 || m.y > 80) score += 200; 
                                    if (forwardDist > 40) score += 150;     
                                    if (score > maxScore && minEnemyDist > 12) { maxScore = score; bestMate = m; }
                                }
                            }
                        });

                        if (bestMate) {
                            let d = getDistance(p.x, p.y, bestMate.x, bestMate.y) || 1;
                            let passPower = 4.5; // 🎯 골키퍼 패스 강도 하향 (기존 6.5)
                            state.ball.vx = ((bestMate.x - p.x) / d) * passPower; 
                            state.ball.vy = ((bestMate.y - p.y) / d) * passPower;
                            state.passTargetId = bestMate.id; 
                            state.lastPasserId = p.id; 
                            if (d > 35) { state.ball.airTicks = Math.max(4, Math.floor(d / 4.5)); state.eventText = "🧤 키퍼 롱 패스 전개!"; }
                        } else {
                            state.ball.vx = dir * 7.5; state.ball.vy = (p.y > 50) ? 3.5 : -3.5; state.ball.airTicks = 5;
                        }
                        p.cooldown = 20; 
                    } 
                    else {
                        let dir = (state.possessionTeam === leftTeam) ? 1 : -1;
                        if (state.phase === 'throw_in') {
                            let fieldPlayers = state.players.filter(p => p.role !== 'GK' && p.id !== state.throwerId);
                            let mates = fieldPlayers.filter(p => p.team === state.possessionTeam);
                            
                            let safeMates = mates.filter(m => {
                                let minE = Math.min(...state.players.filter(e => e.team !== m.team).map(e => getDistance(m.x, m.y, e.x, e.y)));
                                return minE > 6;
                            });
                            if (safeMates.length === 0) safeMates = mates; 
                            
                            safeMates.sort((a,b) => getDistance(state.ball.x, state.ball.y, a.x, a.y) - getDistance(state.ball.x, state.ball.y, b.x, b.y));
                            let target = safeMates[Math.floor(Math.random() * Math.min(3, safeMates.length))];
                            
                            if(target) {
                                let dist = getDistance(state.ball.x, state.ball.y, target.x, target.y) || 1;
                                state.ball.vx = ((target.x - state.ball.x) / dist) * 2.5; state.ball.vy = ((target.y - state.ball.y) / dist) * 2.5; // 🎯 스로인 강도 하향
                                state.passTargetId = target.id;
                                state.lastPasserId = state.throwerId; 
                                if (dist > 15) { state.ball.airTicks = Math.max(2, Math.floor(dist / 2.2)); state.eventText = "🙌 롱 스로인!"; }
                            } else { state.ball.vx = dir * 2.5; state.ball.vy = 0; }
                        }
                        else if (state.phase === 'corner') {
                            let targetX = (state.possessionTeam === leftTeam) ? 90 : 10;
                            let targetY = 50 + (Math.random() - 0.5) * 15;
                            let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                            state.ball.vx = ((targetX - state.ball.x) / dist) * 4.8; state.ball.vy = ((targetY - state.ball.y) / dist) * 4.8;
                            state.ball.airTicks = Math.max(4, Math.floor(dist / 4.0));
                            state.lastPasserId = state.kickerId; 
                            state.eventText = "🎯 코너킥!";
                        }
                        // ★ 완전 무결한 골킥 로직: 불필요한 p.team 등 참조 에러 유발 코드 원천 삭제
                        else if (state.phase === 'goal_kick') {
                            let kickDir = (state.possessionTeam === leftTeam) ? 1 : -1;
                            state.ball.vx = kickDir * 7.5; 
                            state.ball.vy = (Math.random() - 0.5) * 4.0; 
                            state.ball.airTicks = 6;
                            state.eventText = "👟 골킥!";
                        }
                        else if (state.phase === 'free_kick') {
                            let targetX = state.ball.x + dir * 35;
                            let targetY = 50 + (Math.random() - 0.5) * 30;
                            let dist = getDistance(state.ball.x, state.ball.y, targetX, targetY) || 1;
                            state.ball.vx = ((targetX - state.ball.x) / dist) * 4.5; state.ball.vy = ((targetY - state.ball.y) / dist) * 4.5;
                            state.ball.airTicks = Math.max(3, Math.floor(dist / 3.8));
                            state.eventText = "📐 프리킥!";
                        }
                    }
                    state.phase = 'play'; state.gkHolder = null; state.throwerId = null; state.kickerId = null;
                }
                // ★ 주의: 선수들을 굳어버리게 만들던 return 코드는 이 자리에서 완전히 소멸되었습니다.
            }

            // --- 2. 물리 연산 ---
            if (state.phase === 'play') {
                state.ball.x += state.ball.vx; state.ball.y += state.ball.vy;
                state.ball.vx *= 0.90; state.ball.vy *= 0.90; 
                if (state.ball.airTicks && state.ball.airTicks > 0) state.ball.airTicks--;
                if (state.ball.shotTicks && state.ball.shotTicks > 0) state.ball.shotTicks--;
                
                let speedSq = state.ball.vx ** 2 + state.ball.vy ** 2;
                let maxSpeedSq = (state.ball.shotTicks > 0) ? 100 : 25; 
                
                if (speedSq > maxSpeedSq) { 
                    let speed = Math.sqrt(speedSq);
                    let cap = Math.sqrt(maxSpeedSq);
                    state.ball.vx = (state.ball.vx / speed) * cap;
                    state.ball.vy = (state.ball.vy / speed) * cap;
                }
            }

            // --- 3. 소유권 계산 및 루즈볼 판정 ---
            let distArr1 = [], distArr2 = [];
            state.players.forEach(p => {
                if (p.role !== 'GK') {
                    let dist = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                    if (p.team === 1) distArr1.push({p, dist}); 
                    else distArr2.push({p, dist});
                }
            });
            
            let minDist1 = distArr1.length > 0 ? Math.min(...distArr1.map(o => o.dist)) : Infinity;
            let minDist2 = distArr2.length > 0 ? Math.min(...distArr2.map(o => o.dist)) : Infinity;

            // ★ 중요: 인플레이 상황(play)에서만 소유권을 판정하도록 락(Lock)을 걸어둠
            // (골킥 준비 시간에 엉뚱하게 소유권이 넘어가서 골킥이 자책골로 변하는 치명적 버그 차단)
            if (state.phase === 'play') {
                if(minDist1 < minDist2 && minDist1 < 8) state.possessionTeam = 1;
                else if(minDist2 <= minDist1 && minDist2 < 8) state.possessionTeam = 2;
            }
            
            let attTeam = state.possessionTeam;
            let isLooseBall = (minDist1 > 6 && minDist2 > 6);
            
            if (isLooseBall) state.passTargetId = null; 

            let pTargetX = isLooseBall ? state.ball.x + (state.ball.vx * 3) : state.ball.x;
            let pTargetY = isLooseBall ? state.ball.y + (state.ball.vy * 3) : state.ball.y;

            let ballCarrier = state.players.find(p => p.team === attTeam && getDistance(p.x, p.y, state.ball.x, state.ball.y) < 4);

            distArr1.sort((a,b) => a.dist - b.dist);
            distArr2.sort((a,b) => a.dist - b.dist);

            let defLineLeft = 15, defLineRight = 85; 
            state.players.forEach(p => {
                if (p.role === 'DF') {
                    if (p.team === leftTeam && p.x > defLineLeft) defLineLeft = p.x;
                    if (p.team === rightTeam && p.x < defLineRight) defLineRight = p.x;
                }
            });
            // --- 4. 오프더볼 AI ---
            state.players.forEach(p => {
                if (p.cooldown > 0) p.cooldown--;
                if (p.duelCooldown > 0) p.duelCooldown--; 
                
                let targetX = p.baseX, targetY = p.baseY;
                let dir = (p.team === leftTeam) ? 1 : -1;
                let targetGoalX = (p.team === leftTeam) ? 100 : 0;
                let isPressing = false;
                p.isMakingRun = false;

                let organicX = Math.sin(state.ticks / 15 + p.baseX) * 2.5;
                let organicY = Math.cos(state.ticks / 18 + p.baseY) * 2.5;
                
                if (state.phase !== 'play' || state.setPieceTimer > 0) {
                    if (p.role === 'GK') { 
                        // 🎯 키퍼가 공을 잡았을 때는 뒤로 안 가고, 페널티 박스 외곽(전방)으로 천천히 걸어나오며 킥을 준비합니다.
                        if (state.phase === 'gk_hold' && state.gkHolder && p.id === state.gkHolder.id) {
                            targetX = (p.team === leftTeam) ? 14 : 86;
                            targetY = 50;
                        } else {
                            targetX = (p.team===leftTeam?5:95); targetY = 50; 
                        }
                    }
                    else if (state.phase === 'throw_in' && p.id === state.throwerId) { targetX = state.ball.x; targetY = state.ball.y; }
                    else if (state.phase === 'corner' && p.id === state.kickerId) { targetX = state.ball.x; targetY = state.ball.y; }
                    else if (state.phase === 'corner') {
                        let cAttTeam = state.possessionTeam;
                        let goalX = (cAttTeam === leftTeam) ? 88 : 12; 
                        let cDir = (cAttTeam === leftTeam) ? 1 : -1;
                        if (p.team === cAttTeam) {
                            let fieldAttackers = state.players.filter(p2 => p2.team === cAttTeam && p2.role !== 'GK' && p2.id !== state.kickerId);
                            let sortedBySht = [...fieldAttackers].sort((a, b) => {
                                let aSht = (a.stats && a.stats.sht) ? a.stats.sht : 80;
                                let bSht = (b.stats && b.stats.sht) ? b.stats.sht : 80;
                                return aSht - bSht;
                            });
                            let stayBackIds = sortedBySht.slice(0, 2).map(p2 => p2.id);
                            if (stayBackIds.includes(p.id)) {
                                targetX = 50 - (cDir * 6); targetY = p.baseY;
                            } else {
                                let actionIndex = fieldAttackers.filter(p2 => !stayBackIds.includes(p2.id)).indexOf(p);
                                if (actionIndex === 0) { targetX = goalX - (cDir * 3); targetY = (state.ball.y > 50) ? 62 : 38; } 
                                else if (actionIndex === 1) { targetX = goalX - (cDir * 2); targetY = (state.ball.y > 50) ? 38 : 62; } 
                                else if (actionIndex === 2) { targetX = goalX - (cDir * 10); targetY = 50; } 
                                else if (actionIndex === 3) { targetX = goalX - (cDir * 18); targetY = 50 + (organicY > 0 ? 12 : -12); } 
                                else { targetX = goalX - (cDir * (5 + Math.random() * 8)); targetY = 25 + Math.random() * 50; }
                            }
                        } else {
                            let myGoalX = (p.team === leftTeam) ? 5 : 95; let defDir = (p.team === leftTeam) ? 1 : -1;
                            let idx = state.players.filter(p2 => p2.team === p.team && p2.role !== 'GK').indexOf(p);
                            targetX = myGoalX + (defDir * (2 + (idx % 3) * 4)); targetY = 28 + (idx * 5) % 44;
                        }
                    } 
                    // ★ 골킥 전술 준비 상황 포지셔닝
                    else if (state.phase === 'goal_kick') {
                        if (p.team === state.possessionTeam) {
                            // 공격하는 팀 (골킥 받는 팀): 공을 받기 위해 키퍼 앞쪽으로 적당히 내려옴
                            if (p.role === 'FW') { targetX = p.baseX - (dir * 6) + organicX; targetY = p.baseY; }
                            else if (p.role === 'MF') { targetX = p.baseX + (dir * 6) + organicX; targetY = p.baseY; }
                            else { targetX = p.baseX - (dir * 5) + organicX; targetY = p.baseY; } // 🎯 수비수는 장외 이탈 방지 및 키퍼 앞쪽 대기!
                        } else {
                            // 수비하는 팀 (상대 골킥 압박): 라인을 적당히 위로 올림
                            if (p.role === 'FW') { targetX = p.baseX + (dir * 25) + organicX; targetY = p.baseY; }
                            else if (p.role === 'MF') { targetX = p.baseX + (dir * 20) + organicX; targetY = p.baseY; }
                            else if (p.role === 'DF') { targetX = p.baseX + (dir * 20) + organicX; targetY = p.baseY; }
                        }
                    }
                    else if (state.phase === 'gk_hold') {
                        // 🎯 현재 Y축(p.y)을 최대한 유지하며 부드럽게 이동
                        let naturalY = p.y + (p.baseY - p.y) * 0.1 + organicY;
                        
                        if (p.team === state.possessionTeam) {
                            // 🏃‍♂️ 캐칭한 팀 (역습 전개 준비): 원래 포메이션보다 앞쪽(+dir 방향)으로 치고 나감
                            targetX = p.baseX + (dir * 10) + organicX; 
                            targetY = naturalY;
                        } else {
                            // 🛡️ 슛을 뺏긴 팀 (백코트): 자기 진영(-dir 방향)으로 부지런히 후퇴
                            targetX = p.baseX - (dir * 10) + organicX; 
                            targetY = naturalY;
                        }
                    }
                    else if (state.phase === 'throw_in') {
                        // 🎯 스로인 상황 시 양 팀 선수들의 위치 배치 전술 (원하는 수치로 직접 커스텀 가능)
                        let bx = state.ball.x;
                        let by = state.ball.y;

                        if (p.id === state.throwerId) {
                            targetX = bx;
                            targetY = by;
                        } else if (p.team === state.possessionTeam) {
                            // 🏃 공격팀 (스로인): 공 근처로 몰리지 않고 포메이션 Y축(baseY)을 넓게 유지
                            if (p.role === 'FW') {
                                targetX = bx + (dir * 15);
                                targetY = p.baseY; // 본인 위치 유지
                            } else if (p.role === 'MF') {
                                targetX = bx + (dir * 5);
                                // 공과 가장 가까운 미드필더만 살짝 다가오게 설정
                                if (Math.abs(p.baseY - by) < 25) {
                                    targetY = by + (p.baseY > by ? 8 : -8);
                                } else {
                                    targetY = p.baseY;
                                }
                            } else {
                                targetX = bx - (dir * 10);
                                targetY = p.baseY;
                            }
                        } else {
                            // 🛡️ 수비팀 (스로인 수비): 대형을 유지하며 지역 방어
                            if (p.role === 'FW') {
                                targetX = bx + (dir * 10);
                                targetY = p.baseY;
                            } else if (p.role === 'MF') {
                                targetX = bx + (dir * 5);
                                targetY = p.baseY;
                            } else {
                                targetX = bx + (dir * 15);
                                targetY = p.baseY;
                            }
                        }
                    }
                    else if (state.phase === 'corner') {
                        let cAttTeam = state.possessionTeam;
                        let cDir = (cAttTeam === leftTeam) ? 1 : -1;
                        let attackGoalX = (cAttTeam === leftTeam) ? 100 : 0; // 공격해야 할 상대방 골대 위치
                        let defendGoalX = (p.team === leftTeam) ? 0 : 100;   // 지켜야 할 우리 팀 골대 위치
                        let defDir = (p.team === leftTeam) ? 1 : -1;

                        if (p.team === cAttTeam) {
                            // ⚔️ 공격팀 (코너킥 차는 팀) 전술 배치
                            if (p.role === 'FW') {
                                targetX = attackGoalX - (cDir * 6);
                                targetY = 50 + (Math.random() - 0.5) * 15;
                            } else if (p.role === 'MF') {
                                targetX = attackGoalX - (cDir * 16);
                                targetY = 50 + (p.id % 2 === 0 ? 12 : -12);
                            } else {
                                targetX = 50 - (cDir * 10);
                                targetY = p.baseY;
                            }
                        } else {
                            // 🛡️ 수비팀 (코너킥 막는 팀) 전술 배치
                            if (p.role === 'FW') {
                                targetX = 50 - (defDir * 5); 
                                targetY = p.baseY;
                            } else if (p.role === 'MF') {
                                targetX = defendGoalX + (defDir * 18);
                                targetY = 50 + (p.id % 2 === 0 ? 15 : -15);
                            } else {
                                targetX = defendGoalX + (defDir * 5);
                                targetY = 50 + (Math.random() - 0.5) * 20;
                            }
                        }
                    }
                    else {
                        targetX = (p.team === leftTeam) ? p.baseX * 0.8 : 100 - ((100 - p.baseX) * 0.8); 
                        targetY = p.baseY; 
                    }
                } 
                else if (state.isKickoff) {
                    if (p.id === state.kickoffStrikerId) { targetX = 50; targetY = 50; isPressing = true; } 
                }
                else {
                    let myDistArr = (p.team === 1) ? distArr1 : distArr2;
                    let rankObj = myDistArr.find(obj => obj.p === p);
                    let rank = rankObj ? myDistArr.indexOf(rankObj) : 999;
                    let distToBall = rankObj ? rankObj.dist : 999;

                    if (p.role === 'GK') {
                        let myGoalX = p.team === leftTeam ? 0 : 100;
                        // 날아오는 공이 슈팅이고 우리 쪽 골대를 향하는지 판별
                        let isShotTargetingMe = state.ball.shotTicks > 0 && ((p.team === leftTeam && state.ball.vx < 0) || (p.team === rightTeam && state.ball.vx > 0));

                        if (isShotTargetingMe) {
                            targetX = myGoalX + (p.team === leftTeam ? 3 : -3); 
                            // 공의 x축 속도를 이용해 골키퍼 위치까지 도달하는 시간 계산
                            let timeToReach = Math.abs((state.ball.x - targetX) / (state.ball.vx || 1));
                            // 예상되는 도착 Y좌표로 급격하게 타겟 설정
                            let predictedY = state.ball.y + (state.ball.vy * timeToReach);
                            targetY = predictedY;
                            p.isDiving = true; // 다이빙 플래그 켜기
                        } else {
                            p.isDiving = false;
                            let bdx = state.ball.x - myGoalX; let bdy = state.ball.y - 50;
                            let bdist = Math.sqrt(bdx*bdx + bdy*bdy) || 1;
                            let advance = Math.max(2, 12 - (bdist * 0.15));
                            targetX = myGoalX + (bdx / bdist) * advance;
                            targetY = 50 + (bdy / bdist) * advance;
                        }

                        if (p.team === leftTeam) targetX = Math.max(2, Math.min(15, targetX));
                        else targetX = Math.max(85, Math.min(98, targetX));
                        targetY = Math.max(30, Math.min(70, targetY));
                    }
                    else if (attTeam !== p.team) {
                        // ★ 공이 떠있을 때는 낙하 예상 지점(refBallX)을 수비 라인의 기준으로 삼음
                        let refBallX = state.ball.airTicks > 0 ? state.ball.x + (state.ball.vx * state.ball.airTicks) : state.ball.x;
                        let shiftY = (state.ball.y - 50) * 0.4; 
                        
                        let pinchFactor = 1.0;
                        if (p.posId === 'CB') pinchFactor = 0.2; // 센터백 중앙 밀집
                        else if (p.role === 'DF') pinchFactor = 0.6; // 풀백 중앙 좁힘
                        else if (p.role === 'MF') pinchFactor = 0.75; 

                        let blockY = 50 + (p.baseY - 50) * pinchFactor + shiftY + organicY;
                        
                        let distToOwnGoal = Math.abs(p.x - (p.team === leftTeam ? 0 : 100));
                        if (distToOwnGoal < 25) {
                            blockY = 50 + (blockY - 50) * 0.5;
                        }

                        let blockX = p.baseX + organicX;
                        if (p.role === 'FW') blockX = refBallX - (dir * 8);
                        else if (p.role === 'MF') blockX = Math.max(25, Math.min(75, refBallX - (dir * 18)));
                        else if (p.role === 'DF') blockX = Math.max(10, Math.min(90, refBallX - (dir * 28)));

                        if (isLooseBall && rank === 0) {
                            targetX = pTargetX + (p.id % 3 - 1) * 0.5; 
                            targetY = pTargetY + (p.id % 2 === 0 ? 0.5 : -0.5); 
                            isPressing = true;
                        }
                        else if (!isLooseBall && rank === 0 && distToBall < 18) { 
                            targetX = state.ball.x; targetY = state.ball.y; isPressing = true; 
                        } 
                        else if (!isLooseBall && rank === 1 && distToBall < 12) { 
                            targetX = state.ball.x - (dir*4); targetY = state.ball.y; 
                        } 
                        else { 
                            targetX = blockX; targetY = Math.max(10, Math.min(90, blockY)); 
                        }
                    }
                    else if (attTeam === p.team) {
                        // ★ 공격 시에도 낙하 예상 지점(refBallX)을 기준으로 삼아 롱킥 시 미리 전진하게 만듦
                        let refBallX = state.ball.airTicks > 0 ? state.ball.x + (state.ball.vx * state.ball.airTicks) : state.ball.x;
                        let isChasingBall = (state.passTargetId === p.id) || (!state.passTargetId && rank === 0 && distToBall < 15) || (isLooseBall && rank === 0);
                        
                        if (isChasingBall) {
                            targetX = state.ball.x + (state.ball.vx*2); 
                            targetY = state.ball.y + (state.ball.vy*2); 
                            isPressing = true; 
                        }
                        else if (ballCarrier && p.id === ballCarrier.id) {
                            targetX = state.ball.x + (dir * 6); 
                            targetY = state.ball.y;
                        }
                        else {
                            let inFinalThird = (p.team === leftTeam && refBallX > 65) || (p.team === rightTeam && refBallX < 35);
                            let inAttackingHalf = (p.team === leftTeam && refBallX > 50) || (p.team === rightTeam && refBallX < 50);
                            let offsideLine = (p.team === leftTeam) ? defLineRight : defLineLeft;

                            if (p.posId === 'CB') {
                                let maxPushX = (p.team === leftTeam) ? (inAttackingHalf ? 55 : 46) : (inAttackingHalf ? 45 : 54); 
                                let cbTargetX = (p.team === leftTeam) ? Math.min(maxPushX, refBallX - 20) : Math.max(maxPushX, refBallX + 20);
                                targetX = p.baseX + (dir * Math.max(0, (p.team === leftTeam ? cbTargetX - p.baseX : p.baseX - cbTargetX)));
                                targetY = 50 + (p.baseY - 50) * 1.2 + organicY;
                            }
                            else if (p.posId === 'LB' || p.posId === 'RB') {
                                if (inAttackingHalf) {
                                    let overlapDepth = (p.stats && p.stats.spd > 85) ? 22 : 12;
                                    targetX = refBallX + (dir * overlapDepth); 
                                    let goalLine = (p.team === leftTeam) ? 95 : 5;
                                    if (dir === 1 && targetX > goalLine) targetX = goalLine;
                                    if (dir === -1 && targetX < goalLine) targetX = goalLine;
                                    targetY = 50 + (p.baseY - 50) * 0.6; 
                                    p.isMakingRun = true;
                                } else {
                                    let fbAdvance = (p.team === leftTeam) ? refBallX - 5 : refBallX + 5;
                                    targetX = p.baseX + (dir * Math.max(0, (p.team === leftTeam ? fbAdvance - p.baseX : p.baseX - fbAdvance) * 0.8));
                                    targetY = p.baseY + organicY;
                                }
                            }
                            else if (p.role === 'MF') {
                                let isDM = p.posId.includes('DM');
                                let isWing = p.posId.includes('LM') || p.posId.includes('RM') || p.posId.includes('LW') || p.posId.includes('RW');

                                // 🏃 공이 하프라인을 넘기 전이라도, 어느 정도 전진하면 바로 침투 시작!
                                let earlyRunZone = (p.team === leftTeam && refBallX > 35) || (p.team === rightTeam && refBallX < 65);

                                if (isDM) {
                                    let dmAdvance = (p.team === leftTeam) ? refBallX - 12 : refBallX + 12;
                                    targetX = inAttackingHalf ? refBallX - (dir * 12) : p.baseX + (dir * Math.max(0, (p.team === leftTeam ? dmAdvance - p.baseX : p.baseX - dmAdvance) * 0.8));
                                    targetY = p.baseY + organicY;
                                } else {
                                    // 🏃 윙어는 earlyRunZone이 켜지면 무조건 공간으로 스프린트!
                                    if (earlyRunZone && isWing) {
                                        targetX = targetGoalX - (dir * 8);
                                        let stayWideY = 50 + (p.baseY - 50) * 0.85; 
                                        targetY = stayWideY + organicY;
                                        p.isMakingRun = true;
                                    } else if (inAttackingHalf && !isWing) {
                                        targetX = targetGoalX - (dir * 15);
                                        targetY = p.baseY + (Math.random() - 0.5) * 15; 
                                        p.isMakingRun = true;
                                    } else {
                                        let spaceX = refBallX + (dir * 10); 
                                        let spaceY = p.baseY + (state.ball.y - p.baseY) * 0.35;
                                        let bestY = spaceY;
                                        let maxFoundSpace = -Infinity;
                                        
                                        [-15, 0, 15].forEach(offset => {
                                            let testY = spaceY + offset;
                                            if (testY < 5 || testY > 95) return;
                                            let localMin = Infinity;
                                            state.players.forEach(e => {
                                                if (e.team !== p.team && e.role !== 'GK') {
                                                    let dist = getDistance(spaceX, testY, e.x, e.y);
                                                    if (dist < localMin) localMin = dist;
                                                }
                                            });
                                            if (localMin > maxFoundSpace) {
                                                maxFoundSpace = localMin;
                                                bestY = testY;
                                            }
                                        });
                                        targetX = spaceX + organicX;
                                        targetY = bestY + organicY;
                                    }
                                }
                            }
                            else if (p.role === 'FW') {
                                // 🏃 FW(스트라이커) 역시 earlyRunZone부터 일찍 침투 시작!
                                let earlyRunZone = (p.team === leftTeam && refBallX > 35) || (p.team === rightTeam && refBallX < 65);
                                if (earlyRunZone) {
                                    let runDepth = (p.stats && p.stats.spd > 85) ? 2 : 5;
                                    targetX = targetGoalX - (dir * runDepth); 
                                    targetY = 50 + (p.baseY - 50) * 0.75 + (Math.random() - 0.5) * 15; 
                                    p.isMakingRun = true;
                                    
                                    if (dir === 1 && targetX >= offsideLine) targetX = offsideLine - 1.0;
                                    if (dir === -1 && targetX <= offsideLine) targetX = offsideLine + 1.0;
                                } else {
                                    targetX = offsideLine - (dir * 2.0);
                                    targetY = p.baseY + (state.ball.y - p.baseY) * 0.2 + organicY;
                                }
                            }
                            
                            if (p.role !== 'GK' && p.role !== 'DF' && refBallX < offsideLine) {
                                if (dir === 1 && targetX >= offsideLine) targetX = offsideLine - 1.0;
                                if (dir === -1 && targetX <= offsideLine) targetX = offsideLine + 1.0;
                            }
                        }
                    }
                }

                // ★ 물리 태클 경합 엔진 (쿨다운 및 충돌반경 개선)
                if (state.phase === 'play') {
                    state.players.forEach(other => {
                        if (other !== p && other.role !== 'GK') {
                            let dx = p.x - other.x; let dy = p.y - other.y;
                            let d = Math.sqrt(dx*dx + dy*dy) || 1;
                            
                            // 충돌 반경을 살짝 넓혀서 겹치기 전에 경합 판정 발동
                            if (d < 1.1) { 
                                if (p.team === other.team) {
                                    // 같은 팀끼리 길막 방지 거리도 축소 (0.5 -> 0.3 / 1.5 -> 1.1)
                                    let repelForce = (d < 0.3) ? 0.8 : 0.1;
                                    let repel = (1.1 - d) * repelForce;
                                    targetX += (dx / d) * repel; targetY += (dy / d) * repel;
                                } else {
                                    // 적팀과의 경합 (움찔거림의 주범이던 기본 밀어내기 로직 삭제)
                                    if (p.duelCooldown <= 0 && other.duelCooldown <= 0) {
                                        let pHasBall = (ballCarrier && ballCarrier.id === p.id);
                                        let otherHasBall = (ballCarrier && ballCarrier.id === other.id);

                                        if (pHasBall || otherHasBall) {
                                            // ★ 3초(30틱) 동안 재경합 절대 금지 (무한 비비기 차단)
                                            p.duelCooldown = 30; 
                                            other.duelCooldown = 30;
                                            
                                            let pSpeed = (p.stats && p.stats.spd) ? p.stats.spd : 80;
                                            let oSpeed = (other.stats && other.stats.spd) ? other.stats.spd : 80;
                                            
                                            // 🎯 몸싸움/수비(def) 스탯 추가: 데이터베이스에 없으면 기본값 80 자동 부여
                                            let pDef = (p.stats && p.stats.def) ? p.stats.def : 80;
                                            let oDef = (other.stats && other.stats.def) ? other.stats.def : 80;
                                            
                                            // 🎯 밸런스 최적화: 스피드 40% + 몸싸움(수비) 60% 비율로 합산하여 경합 점수 산정
                                            let pScore = (pSpeed * 0.3) + (pDef * 0.7) + (Math.random() * 30);
                                            let oScore = (oSpeed * 0.3) + (oDef * 0.7) + (Math.random() * 30);

                                            if (Math.random() < 0.20 || (oScore > pScore + 10 && !pHasBall)) {
                                                state.ball.vx = (Math.random() - 0.5) * 6; 
                                                state.ball.vy = (Math.random() - 0.5) * 6;
                                                state.eventText = "⚔️ 태클 탈취 턴오버!";
                                                state.possessionTeam = 0; 
                                                state.passTargetId = null; 
                                                
                                                if (pHasBall) { 
                                                    p.cooldown = 5; p.stunTicks = 15; 
                                                    p.x += (dx / d) * 3.0; p.y += (dy / d) * 3.0; // 확 밀쳐냄
                                                } else { 
                                                    other.cooldown = 5; other.stunTicks = 15; 
                                                    other.x -= (dx / d) * 3.0; other.y -= (dy / d) * 3.0;
                                                }
                                            } else {
                                                if (pScore > oScore) {
                                                    other.cooldown = 5; 
                                                    other.stunTicks = 15; 
                                                    other.x -= (dx / d) * 3.0; 
                                                    other.y -= (dy / d) * 3.0;
                                                    state.eventText = "⚡ 수비수를 벗겨냅니다!";
                                                } else {
                                                    p.cooldown = 5; 
                                                    p.stunTicks = 10; 
                                                    p.x += (dx / d) * 2.5; p.y += (dy / d) * 2.5;
                                                    state.eventText = "🧱 수비벽 지연!";
                                                    state.ball.vx *= 0.5; state.ball.vy *= 0.5;
                                                }
                                            }
                                        }
                                    }
                                    // 주의: else (쿨타임 중일 때) 블록을 아예 삭제했습니다.
                                    // 이제 쿨타임 중에 스치면 물리적으로 버벅거리지 않고 부드럽게 스쳐 지나갑니다.
                                }
                            }
                        }
                    });
                }

                targetX = isNaN(targetX) ? p.baseX : Math.max(2, Math.min(98, targetX)); 
                targetY = isNaN(targetY) ? p.baseY : Math.max(2, Math.min(98, targetY));
                
                let pSpd = (p.stats && p.stats.spd) ? p.stats.spd : 80;
                let moveSpeed = (pSpd / 100) * 0.85; 
                // 🏃‍♂️ 선수 스프린트 속도 대폭 상향 (유저 커스텀 수치 적용)
                if (ballCarrier && p.id === ballCarrier.id) {
                    moveSpeed *= 2.1; // 🎯 공을 잡은 상태의 돌파 속도를 미친 듯이 끌어올립니다.
                } else if (isPressing || state.passTargetId === p.id || p.isMakingRun) {
                    moveSpeed *= 1.8; // 🎯 일반 침투 및 압박 스프린트 속도도 상향
                }
                // ★ [핵심 1] 세트피스 타이머가 도는 동안(공격 멈춤) 지정된 포메이션 자리로 '순간이동'급으로 뛰어가게 만듦
                if (state.phase !== 'play' && state.phase !== 'gk_hold') {
                    moveSpeed *= 5.0;
                } else if (state.phase === 'gk_hold') {
                    moveSpeed *= 1.3; // 공수 교환 템포에 맞춰서 선수들이 살짝만 빠르게(1.3배속) 조깅하며 이동함
                }
                // 골키퍼 반응속도
                // 대포알 슛을 따라가게 하려면 이 수치를 4.0, 5.0 등으로 확 올려주세요.
                if (p.role === 'GK' && p.isDiving) moveSpeed *= 3.2; // 다이빙 시 폭발적인 속도로 몸을 날림

                if (p.stunTicks && p.stunTicks > 0) {
                    p.stunTicks--;
                    moveSpeed *= 0.3; // 30%의 속도로 비틀거림
                    
                    // 핵심: 공을 쫓아 돌진하는 것을 멈추고, 밸런스를 잡기 위해 자기 포메이션 자리로 방향을 잃고 물러남
                    targetX = p.baseX; 
                    targetY = p.baseY; 
                }

                let distToTarget = getDistance(p.x, p.y, targetX, targetY) || 1;
                if (distToTarget > moveSpeed) {
                    p.x += ((targetX - p.x) / distToTarget) * moveSpeed;
                    p.y += ((targetY - p.y) / distToTarget) * moveSpeed;
                } else { p.x = targetX; p.y = targetY; }
            });

            // --- 5. 스마트 상황 판단 ---
            state.players.forEach(p => {
                // 4.0가 현재 다이빙 시 팔을 뻗는 범위입니다.
                // 슈팅을 너무 못 막는다 싶으면 이 수치를 5.5나 6.5로 늘려주세요. 블랙홀처럼 빨아들여 막습니다.
                let touchRadius = p.role === 'GK' ? (state.ball.shotTicks > 0 ? 4.0 : 3.0) : 1.8;
                let distToBallAct = getDistance(p.x, p.y, state.ball.x, state.ball.y);
                let isBallInAir = (state.ball.airTicks && state.ball.airTicks > 0);
                let dir = (p.team === leftTeam) ? 1 : -1;
                let targetGoalX = (p.team === leftTeam) ? 100 : 0;

                if (!isBallInAir && distToBallAct < touchRadius && p.cooldown <= 0 && state.phase === 'play') {
                    state.lastTouchTeam = p.team;
                    state.lastTouchPlayerName = p.name; 
                    
                    // 🎯 각 팀별 마지막 터치 선수를 독립적으로 기록 (자책골 방어용)
                    if (p.team === 1) state.lastTeam1Touch = p.name;
                    else if (p.team === 2) state.lastTeam2Touch = p.name;
                    
                    state.passTargetId = null;

                    if (state.isKickoff) {
                        if (p.team === state.kickoffTeam) {
                            let mates = state.players.filter(m => m.team === p.team && m.role !== 'GK' && m.id !== p.id);
                            let backMates = mates.filter(m => (dir === 1 ? m.x < p.x : m.x > p.x));
                            if(backMates.length === 0) backMates = mates;
                            let targetMate = backMates[Math.floor(Math.random() * Math.min(3, backMates.length))]; 
                            if (targetMate) {
                                let d = getDistance(p.x, p.y, targetMate.x, targetMate.y) || 1;
                                state.ball.vx = ((targetMate.x - p.x) / d) * 3.5; state.ball.vy = ((targetMate.y - p.y) / d) * 3.5;
                                state.passTargetId = targetMate.id; 
                                state.lastPasserId = p.id; 
                                io.to(roomCode).emit('playSound', 'kick'); 
                                p.cooldown = 12; 
                                state.isKickoff = false; 
                                return; 
                            }
                        }
                        state.isKickoff = false; 
                    }

                    if (p.role === 'GK') {
                        let isInBox = Math.abs(p.x - (p.team === leftTeam ? 0 : 100)) < 20 && p.y > 20 && p.y < 80;
                        if (isInBox && state.phase === 'play' && state.setPieceTimer <= 0) {
                            // 0.4는 40% 확률로 공을 쳐내고(루즈볼 유도), 60% 확률로 안전하게 잡는다는 뜻입니다.
                            // 0.7로 바꾸면 70% 확률로 공을 쳐내서 루즈볼(세컨볼) 상황이 더 자주 발생해 박진감이 넘치게 됩니다.
                            if (state.ball.shotTicks > 0 && Math.random() < 0.40) {
                                io.to(roomCode).emit('playSound', 'kick');
                                // 🎯 펀칭 시 공이 튀는 강도를 대폭 줄여 페널티 박스 안쪽 루즈볼 상황 유도
                                state.ball.vx = dir * (1.5 + Math.random() * 2.0); // 최대 7.0에서 3.5로 감소
                                state.ball.vy = (Math.random() - 0.5) * 5.0; // 위아래로 튀는 범위도 반타작
                                state.ball.shotTicks = 0;
                                p.cooldown = 5;
                                state.eventText = "🧤 슈퍼 세이브 (펀칭)!";
                            }
                            else {
                                // 안정적인 캐칭
                                state.phase = 'gk_hold'; state.gkHolder = p; state.setPieceTimer = 15;
                                state.ball.vx = 0; state.ball.vy = 0; state.ball.x = p.x; state.ball.y = p.y; 
                                state.eventText = state.ball.shotTicks > 0 ? "🧤 엄청난 선방 (캐칭)!" : "키퍼 선방!"; 
                                state.ball.shotTicks = 0;
                                p.cooldown = 20;
                                
                                // 🎯 치명적 버그 픽스: 키퍼가 공을 잡는 순간 소유권을 수비팀(키퍼팀)으로 즉시 가져옵니다!
                                state.possessionTeam = p.team;
                            }
                        } else {
                            io.to(roomCode).emit('playSound', 'kick'); state.ball.vx = dir * 6.0; state.ball.vy = (p.y > 50) ? 3.0 : -3.0; p.cooldown = 15;
                        }
                        return;
                    }

                    let distToGoal = getDistance(p.x, p.y, targetGoalX, 50);
                    let shotBlocked = false;

                    if (distToGoal > 15) {
                        state.players.forEach(e => {
                            if (e.team !== p.team && e.role !== 'GK') {
                                if (getDistance(p.x, p.y, e.x, e.y) < 6 && 
                                    pDistance(e.x, e.y, p.x, p.y, targetGoalX, 50) < 2.5 && 
                                    ((dir===1 && e.x > p.x) || (dir===-1 && e.x < p.x))) shotBlocked = true;
                            }
                        });
                    }

                    let pPas = (p.stats && p.stats.pas) ? p.stats.pas : 80;
                    let pSpd = (p.stats && p.stats.spd) ? p.stats.spd : 80;
                    let pSht = (p.stats && p.stats.sht) ? p.stats.sht : 80;

                    let inFinalThird = (p.team === leftTeam && p.x > 65) || (p.team === rightTeam && p.x < 35);
                    let inAttackingHalf = (p.team === leftTeam && p.x > 50) || (p.team === rightTeam && p.x < 50);
                    let inOwnHalf = !inAttackingHalf;

                    let inOpponentBox = (p.team === leftTeam && p.x > 84 && p.y > 20 && p.y < 80) || (p.team === rightTeam && p.x < 16 && p.y > 20 && p.y < 80);
                    let angleToGoal = Math.abs(p.y - 50); 
                    let maxShotDist = (pSht >= 85) ? 24 : (pSht >= 80 ? 20 : 16); 
                    
                    let teammatesAhead = 0;
                    state.players.forEach(m => {
                        if (m.team === p.team && m.id !== p.id && m.role !== 'GK') {
                            let forwardDist = (p.team === leftTeam) ? (m.x - p.x) : (p.x - m.x);
                            if (forwardDist > 0 && getDistance(p.x, p.y, m.x, m.y) < 25) teammatesAhead++;
                        }
                    });

                    // 🎯 역습 상황 및 수비수 숫자 파악 AI
                    let defendersAhead = 0;
                    state.players.forEach(e => {
                        if (e.team !== p.team && e.role !== 'GK') {
                            let eForwardDist = (p.team === leftTeam) ? (e.x - p.x) : (p.x - e.x);
                            if (eForwardDist > -3) defendersAhead++; // 내 앞에 남은 수비수 카운트
                        }
                    });

                    let isCounterAttack = (defendersAhead <= 3) && inAttackingHalf; // 수비가 적은 완벽한 역습 찬스
                    let isIsolatedFront = (teammatesAhead === 0) && inAttackingHalf; // 앞에 줄 곳이 없을 때 단독 찬스

                    let canShoot = false;
                    let shootProb = 0;

                    if (!shotBlocked) {
                        // 🎯 핵심: 페널티 박스 안이거나, 페널티 아크(거리 22 이하 & 정면)면 무조건 슈팅(1.0)
                        if (inOpponentBox || (distToGoal <= 22 && angleToGoal < 20)) {
                            canShoot = true;
                            shootProb = 1.0; 
                        } else if (distToGoal < maxShotDist) {
                            if (angleToGoal < 20) {
                                shootProb = (teammatesAhead === 0) ? 1.0 : 0.7; 
                                canShoot = true;
                            } else if (angleToGoal < 32) {
                                shootProb = 0.4; 
                                canShoot = true;
                            }
                        }
                    }
                    
                    if (canShoot && Math.random() < shootProb) {
                        io.to(roomCode).emit('playSound', 'kick');
                        let power = distToGoal < 15 ? 6.0 : 8 + ((pSht - 70) * 0.25);
                        let cornerTarget = (Math.random() > 0.5) ? 1 : -1; 
                        let offsetSpread = 11 - (pSht > 85 ? (Math.random() * 2) : (Math.random() * 6));
                        let aimY = 50 + (cornerTarget * offsetSpread);
                        let dx = targetGoalX - p.x, dy = aimY - p.y; let d = Math.sqrt(dx*dx + dy*dy) || 1; 
                        state.ball.vx = (dx / d) * power; state.ball.vy = (dy / d) * power;
                        state.ball.shotTicks = distToGoal < 15 ? 8 : 15;
                        
                        // 🚨 치명적 버그 수정: 슛을 차놓고 리턴(종료)하지 않아서 바로 드리블 속도로 덮어씌워지던 문제 해결
                        p.cooldown = 15;
                        state.eventText = "⚽ 강력한 슈팅!";
                        return; 
                    }

                    // ★ 1. 압박 기준치 대폭 축소 (너무 쉽게 백패스 금지)
                    let enemies = state.players.filter(e => e.team !== p.team && e.role !== 'GK');
                    let nearestEnemyDist = enemies.length > 0 ? Math.min(...enemies.map(e => getDistance(p.x, p.y, e.x, e.y))) : 999;
                    let isHeavilyPressed = nearestEnemyDist < 3.5; // 진짜 뺏기기 직전의 초근접 압박
                    let isPressed = nearestEnemyDist < 8.0;        // 일반적인 접근 방해

                    let passOptions = [];
                    state.players.forEach(m => {
                        if (m.team === p.team && m.id !== p.id && m.role !== 'GK') {
                            let dist = getDistance(p.x, p.y, m.x, m.y);
                            if (dist < 5 || dist > 45) return; 

                            let forwardDist = (p.team === leftTeam) ? (m.x - p.x) : (p.x - m.x); 
                            let laneBlocked = false;
                            let minEnemyDistToM = Infinity;
                            
                            state.players.forEach(e => {
                                if (e.team !== p.team && e.role !== 'GK') {
                                    if (pDistance(e.x, e.y, p.x, p.y, m.x, m.y) < 3.0) laneBlocked = true;
                                    let d2 = getDistance(m.x, m.y, e.x, e.y);
                                    if (d2 < minEnemyDistToM) minEnemyDistToM = d2;
                                }
                            });

                            let score = 0; let isThrough = false; let isCutback = false; let isCross = false;
                            if (laneBlocked) score -= 3000; 

                            // 전진 패스와 백패스(후진) 철저히 분리
                            if (forwardDist > -2) {
                                // 전진 패스는 가산점 팍팍
                                if (isCounterAttack) score += (forwardDist * 15.0); 
                                else if (inAttackingHalf) score += (forwardDist * (pPas > 85 ? 10.0 : 7.0)); 
                                else score += (forwardDist * (pPas > 85 ? 6.5 : 5.0)); 

                                let isWinger = p.y < 20 || p.y > 80;
                                let isReceiverCentral = m.y > 30 && m.y < 70;
                                // 🎯 박스 안쪽인지, 하프스페이스(측면과 중앙 사이의 틈)인지 세밀하게 판별
                                let isReceiverInBox = (p.team === leftTeam && m.x > 84 && m.y > 20 && m.y < 80) || (p.team === rightTeam && m.x < 16 && m.y > 20 && m.y < 80);
                                let isHalfSpace = (m.y >= 20 && m.y <= 35) || (m.y >= 65 && m.y <= 80);
                                
                                // 🎯 무지성 크로스 완전 차단 및 스마트 연계 플레이 유도
                                if (isWinger && inFinalThird) {
                                    let isDeepZone = (p.team === leftTeam && p.x > 80) || (p.team === rightTeam && p.x < 20);
                                    
                                    if (isDeepZone) {
                                        if (isReceiverInBox) {
                                            // 1️⃣ 박스 안에 동료가 기다리고 있을 때만 정통 크로스!
                                            score += 4000; 
                                            isCross = true;
                                        } else if (isHalfSpace && m.isMakingRun) {
                                            // 2️⃣ 박스가 비었으면, 하프스페이스로 침투하는 동료(미드필더 등)에게 찔러주는 컷백/스루패스
                                            score += 3000;
                                            isThrough = true;
                                        } else if (dist < 18 && minEnemyDistToM > 4) {
                                            // 3️⃣ 다 안 되면 근처 미드필더/풀백과 짧게 주고받는 2대1 패스 연계 (어그로 핑퐁)
                                            score += 2500;
                                        } else {
                                            // 4️⃣ 줄 곳이 마땅치 않으면 패스 점수를 폭락시켜서 '직접 드리블(돌파)' 하도록 강제함!
                                            score -= 5000; 
                                        }
                                    }
                                }

                                let isMWing = m.y < 25 || m.y > 75; 
                                // 공격 진영에서 측면 넓은 빈 공간(수비거리 6 이상)으로 전진하는 동료가 있으면 무조건 점수 팍팍 퍼줌!
                                if (inAttackingHalf && isMWing && forwardDist > 0 && minEnemyDistToM > 6 && !laneBlocked) {
                                    score += 1500; // 윙어/공격수의 깐깐한 드리블 커트라인(800점)을 뚫고 측면으로 패스하게 만듦
                                }
                                if (m.isMakingRun && minEnemyDistToM > 4 && !laneBlocked) {
                                    if (isMWing) {
                                        // 미드필더의 킬패스는 최고점(2500)을 유지하고, 
                                        // 공격수 등 다른 포지션이 측면 침투 동료에게 내주는 패스 점수도 기존 400 -> 1200으로 대폭 상승시켜 적극적인 오버랩 연계 유도!
                                        if (p.role === 'MF') score += 2500;
                                        else score += 1200; 
                                    } else {
                                        score += inAttackingHalf ? (pPas * 12) : (pPas * 8); 
                                    }
                                    isThrough = true;
                                }
                            }
                            else {
                                // 후진 패스 (백패스)
                                let isDeep = (p.team === leftTeam && p.x > 85) || (p.team === rightTeam && p.x < 15);
                                let isReceiverInBox = (p.team === leftTeam && m.x > 75 && m.x < p.x) || (p.team === rightTeam && m.x < 25 && m.x > p.x);
                                let isReceiverCentral = m.y > 30 && m.y < 70;

                                if (isDeep && isReceiverInBox && isReceiverCentral) {
                                    score += 6000; 
                                    isCutback = true;
                                } else if (inAttackingHalf) {
                                    let backpassScore = -5000; 
                                    
                                    // 🎯 역습 찬스이거나 앞이 뻥 뚫렸을 때는 템포를 죽이는 백패스 절대 금지! (돌파 유도)
                                    if (isCounterAttack || isIsolatedFront) {
                                        backpassScore = -99999;
                                    }
                                    else if (isHeavilyPressed && minEnemyDistToM > 8 && !laneBlocked) {
                                        backpassScore = 80; 
                                    }
                                    else if (isPressed && minEnemyDistToM > 18 && !laneBlocked && Math.random() < 0.2) {
                                        backpassScore = 40; 
                                    }
                                    else if (minEnemyDistToM > 15 && Math.abs(m.y - 50) < 20 && m.role === 'MF' && Math.random() < 0.15) {
                                        backpassScore = 30; 
                                    }
                                    else if (m.isMakingRun && minEnemyDistToM > 10) {
                                        backpassScore = 20;
                                    }

                                    score += backpassScore;
                                } else {
                                    if (isPressed && minEnemyDistToM > 10 && !laneBlocked) score += 100; 
                                    else score -= 1500;
                                }
                            }

                            score -= (dist * (pPas > 85 ? 0.3 : 1.0)); 
                            // 🎯 [핵심] 빈 공간(안전한 동료)을 찾는 AI 지능 상향!
                            // 공격 진영(inAttackingHalf)이나 파이널 서드에서는 수비수와 거리가 먼(minEnemyDistToM) 동료에게 주는 점수 가중치를 2배 이상 높임.
                            if (inAttackingHalf) {
                                score += (minEnemyDistToM * 12); 
                            } else {
                                score += (minEnemyDistToM * 7); 
                            }
                            
                            if (state.lastPasserId === m.id) score -= 2000; 
                            
                            // 🎯 주사위 억까 방지: 패스 스탯이 높을수록 랜덤 변수를 줄여서 일관되게 가장 좋은 옵션을 선택하도록 안정성 강화
                            score += (Math.random() * (100 - pPas) * 0.4);

                            if (score > 0) passOptions.push({ mate: m, score: score, dist: dist, isThrough: isThrough, isCutback: isCutback, isCross: isCross });
                        }
                    });

                    passOptions.sort((a, b) => b.score - a.score);
                    let bestOption = passOptions.length > 0 ? passOptions[0] : null;
                    
                    if (passOptions.length > 1 && Math.random() < 0.2) {
                        if (passOptions[1].score > 30) bestOption = passOptions[1]; 
                    }

                    let ballSpeedSq = state.ball.vx ** 2 + state.ball.vy ** 2;
                    if (ballSpeedSq > 10) { 
                        // 🎯 박스 안이나 아크 부근에 패스가 도달하면 볼 트래핑을 생략하고 즉시 다이렉트 슛 폭발!
                        if (isInShootingRange) {
                            io.to(roomCode).emit('playSound', 'kick');
                            let power = distToGoal < 15 ? 7.0 : 10.5 + ((pSht - 70) * 0.25);
                            let cornerTarget = (Math.random() > 0.5) ? 1 : -1; 
                            let offsetSpread = 11 - (pSht > 85 ? (Math.random() * 2) : (Math.random() * 6));
                            let aimY = 50 + (cornerTarget * offsetSpread);
                            
                            let dx = targetGoalX - p.x, dy = aimY - p.y; let d = Math.sqrt(dx*dx + dy*dy) || 1; 
                            state.ball.vx = (dx / d) * power; state.ball.vy = (dy / d) * power;
                            state.ball.shotTicks = distToGoal < 15 ? 8 : 15; 
                            p.cooldown = 15; // 슈팅 후 쿨다운 적용
                            state.eventText = "⚡ 전율의 논스톱 슈팅!!!";
                            return;
                        }

                        state.ball.vx = 0; state.ball.vy = 0; 
                        state.ball.x = p.x + (dir * 0.5); state.ball.y = p.y; 
                        p.cooldown = 0; state.eventText = "볼 컨트롤"; return; 
                    }

                    // ★ 2. 윙어 돌파 특화 및 무조건 드리블 유도
                    let isWingerPos = (p.y < 22 || p.y > 78);
                    // 🎯 윙어는 공을 잡으면 95% 확률로 일단 무조건 치고 달리도록 설정
                    let isWingerDrive = isWingerPos && inAttackingHalf && Math.random() < 0.95; 
                    
                    let isCounterDrive = isCounterAttack || isIsolatedFront;
                    
                    // 🎯 [수정 3] 공격수(FW)와 윙어는 하프라인만 넘으면 무조건 패스보다 '드리블(볼 소유)'을 1순위로 강제
                    let wantsToHold = (p.role === 'FW' && inAttackingHalf) || isWingerDrive || isCounterDrive; 
                    
                    let isInShootingRange = inOpponentBox || (distToGoal <= 22 && angleToGoal < 25);
                    
                    // 🎯 [수정 4] 공격진이 공을 잡았을 때, 어설픈 패스를 완전히 차단하고 드리블을 치도록 커트라인 '초대폭' 상향
                    // 기존 60은 점수를 너무 쉽게 넘겨 논스톱 패스가 나갔음. 확실한 기회(800점 이상)가 아니면 직접 몰고 감.
                    let passThreshold = wantsToHold ? (bestOption && (bestOption.isThrough || bestOption.isCross || bestOption.isCutback) ? 800 : 2500) : 25;
                    
                    if (isInShootingRange) {
                        passThreshold = (bestOption && bestOption.isCutback) ? 180 : 999;
                    }

                    if (isHeavilyPressed && !wantsToHold && !isInShootingRange) passThreshold = 10;

                    if (bestOption && bestOption.score > passThreshold) {
                        // 1️⃣ 좌표 오차(삑사리) 대폭 감소: 패스 스탯에 따른 오차율을 절반 이하로 줄임
                        let errorMargin = Math.max(0.02, (100 - pPas) * 0.012); 
                        let targetX = bestOption.mate.x + (Math.random() - 0.5) * errorMargin; 
                        let targetY = bestOption.mate.y + (Math.random() - 0.5) * errorMargin;
                        
                        let isBackpass = (p.team === leftTeam) ? (targetX < p.x) : (targetX > p.x);
                        
                        if (isBackpass) {
                            targetX = bestOption.mate.x; targetY = bestOption.mate.y; 
                            bestOption.isThrough = false; bestOption.isCross = false;
                        } else if (bestOption.isThrough || bestOption.isCross) { 
                            // 2️⃣ 스루패스 거리 조절: 앞으로 너무 길게 찔러서 키퍼에게 헌납하거나 아웃되는 현상 방지 (리드 거리 축소)
                            let leadDist = (bestOption.mate.stats && bestOption.mate.stats.spd > 85) ? 6.5 : 4.0;
                            
                            // 파이널 서드에서는 공간이 좁으므로 수비에게 안 잘리게 발밑에 더 가깝게 줌
                            if (inFinalThird) leadDist *= 0.6; 
                            
                            targetX += dir * leadDist; 
                        }
                        
                        io.to(roomCode).emit('playSound', 'kick');
                        let d = getDistance(p.x, p.y, targetX, targetY) || 1; 
                        
                        // 3️⃣ 패스 속도(파워) 상향: 공이 느려서 굴러가다 끊기는 현상(인터셉트) 방지 (Divider 감소, 최대 파워 5.5로 상향)
                        let powerDivider = (bestOption.isThrough || bestOption.isCross) ? 5.0 : 4.0;
                        let power = Math.max(2.5, Math.min(d / powerDivider, 5.5));

                        state.ball.vx = ((targetX - p.x) / d) * power; state.ball.vy = ((targetY - p.y) / d) * power; 
                        
                        if (bestOption.isCutback) {
                            state.eventText = "🎯 결정적 컷백!";
                        } else if (bestOption.isCross) {
                            state.ball.airTicks = Math.floor(d / 4.0);
                            state.eventText = "🚀 크로스!";
                        } else if (isBackpass) {
                            state.eventText = isHeavilyPressed ? "🛡️ 위기 탈출" : "템포 조절";
                        } else if (d > 20) {
                            state.ball.airTicks = Math.floor(d / 5.0);
                            state.eventText = bestOption.isThrough ? "🎯 스루패스!" : "🚀 롱킥 전환!";
                        } else { 
                            state.eventText = bestOption.isThrough ? "창의적 스루패스!" : "연계 플레이"; 
                        }
                        
                        state.passTargetId = bestOption.mate.id; state.lastPasserId = p.id; p.cooldown = 8; 
                    } 
                    else {
                        let threats = state.players.filter(e => e.team !== p.team && e.role !== 'GK');
                        let imminentThreat = threats.find(e => {
                            let isForward = (dir === 1 && e.x > p.x) || (dir === -1 && e.x < p.x);
                            return isForward && getDistance(p.x, p.y, e.x, e.y) < 12 && Math.abs(e.y - p.y) < 8;
                        });

                        let nextVx = dir * (pSpd / 100) * 1.8; 
                        let centerDriveVy = (50 - p.y) * 0.05 + (Math.random() - 0.5);
                        let nextVy = centerDriveVy * 0.8; 

                        if (isWingerDrive) {
                            let isNearBox = (p.team === leftTeam && p.x > 80) || (p.team === rightTeam && p.x < 20);
                            let currentBallSpeed = Math.sqrt(state.ball.vx**2 + state.ball.vy**2);
                            
                            // 🎯 전방에 빈 공간(수비수와의 거리)이 얼마나 있는지 계산
                            let forwardEnemies = state.players.filter(e => e.team !== p.team && e.role !== 'GK' && ((dir === 1 && e.x > p.x) || (dir === -1 && e.x < p.x)));
                            let nearestEnemyDist = forwardEnemies.length > 0 ? Math.min(...forwardEnemies.map(e => getDistance(p.x, p.y, e.x, e.y))) : 999;
                        
                            // 1️⃣ 퍼스트 터치: 패스를 받았거나 공이 빠르게 굴러오면 일단 발밑에 잡아둠 (소유권 확보)
                            if (currentBallSpeed > 1.5 && p.cooldown === 0) {
                                nextVx = dir * (pSpd / 100) * 0.8; 
                                nextVy = 0;
                                p.cooldown = 1;
                                state.eventText = "볼 터치 및 소유";
                            } 
                            // 2️⃣ 파이널 서드 진입: 폭발적이고 세밀한 컷인 (발에 붙이는 드리블 속도 상향)
                            else if (isNearBox) {
                                // 🎯 파이널 서드 돌입! (동료가 없어서 직접 요리함)
                                let distToBaseline = (p.team === leftTeam) ? (100 - p.x) : p.x;
                                let isDeepCorner = distToBaseline < 8; // 코너킥 라인(엔드라인) 근처인지 확인
                                
                                // 내 앞길을 가로막는 수비수가 있는지 탐지
                                let blockerAhead = forwardEnemies.find(e => Math.abs(e.y - p.y) < 6 && getDistance(p.x, p.y, e.x, e.y) < 10);
                                
                                if (isDeepCorner) {
                                    // 1️⃣ 코너킥 라인까지 깊숙하게 다다랐다면, 골대를 향해 90도(직각)로 꺾어 들어가는 무자비한 엔드라인 돌파!
                                    nextVx = dir * (pSpd / 100) * 0.5; // 앞으로 가는 건 거의 멈추고
                                    nextVy = (p.y < 50) ? 2.8 : -2.8;  // 골대를 향해 수직으로 급격히 파고듦!
                                    state.eventText = "⚡ 엔드라인 직각 돌파!";
                                } else if (blockerAhead) {
                                    // 2️⃣ 앞에 수비가 버티고 있다면, 박스 모서리 쪽(대각선)으로 날카롭게 컷인
                                    nextVx = dir * (pSpd / 100) * 1.8; 
                                    nextVy = (p.y < 50) ? 2.2 : -2.2;  
                                    state.eventText = "⚡ 중앙 대각 컷인!";
                                } else {
                                    // 3️⃣ 앞이 뻥 뚫려있다면, 섣불리 꺾지 않고 코너 라인까지 더 깊숙이 일자 돌파 (수비 붕괴 목적)
                                    nextVx = dir * (pSpd / 100) * 2.8; 
                                    nextVy = (p.y < 50) ? 0.2 : -0.2; // 터치라인 밖으로 안 나가게 미세하게 안쪽으로만 유지
                                    state.eventText = "💨 엔드라인 깊숙이 돌파!";
                                }
                                p.cooldown = 1; 
                            }
                            // 3️⃣ 측면 빈 공간: 짧게 쳐놓고 미친 듯이 따라가는 치달
                            else if (nearestEnemyDist > 12) {
                                nextVx = dir * (pSpd / 100) * 2.6; // 너무 멀리 차지 않게 강도 조절 (기존 3.8 -> 2.6)
                                nextVy = 0; 
                                state.eventText = "💨 터치라인 치달!";
                                p.cooldown = 2; // 공을 차놓고 2틱 뒤에 다시 터치 (거리 짧아짐)
                                
                                // ★ 핵심 버그 해결: 공을 차고 나서도 선수가 스프린트 가속(1.8배속)을 받도록 플래그 강제 온!
                                p.isMakingRun = true; 
                            } 
                            // 4️⃣ 수비가 바로 앞에 있을 때: 일반 돌파
                            else {
                                nextVx = dir * (pSpd / 100) * 1.4;
                                nextVy = 0;
                                state.eventText = "측면 돌파";
                                p.cooldown = 0;
                            }
                        }
                        // ★ 역습 및 단독 돌파 전용 움직임 (빈 공간으로 쇄도)
                        else if (isCounterDrive && !imminentThreat) {
                            nextVx = dir * (pSpd / 100) * 1.6; // 중앙을 가르는 폭발적인 직진 속도
                            let cutInsideVy = (50 - p.y) * 0.15; // 골대를 향해 사선으로 파고듦
                            nextVy = cutInsideVy;
                            state.eventText = isCounterAttack ? "⚡ 치명적인 역습!" : "⚡ 단독 돌파!";
                            p.cooldown = 1;
                        }
                        else if (imminentThreat) {
                            let spaceAbove = imminentThreat.y - 0; 
                            let spaceBelow = 100 - imminentThreat.y;
                            let dodgeDir = spaceAbove > spaceBelow ? -1 : 1; 

                            if (p.y < 15) dodgeDir = 1;
                            if (p.y > 85) dodgeDir = -1;

                            nextVy = dodgeDir * 2.0; 
                            // 🎯 수비를 회피할 때도 옆으로만 새지 않고 앞으로 치고 나가는 전진성 극대화
                            nextVx = dir * (pSpd / 100) * (isCounterDrive ? 1.4 : 1.1); 
                            state.eventText = wantsToHold ? "⚡ 돌파를 위한 회피!" : "회피 기동!";
                            p.cooldown = 0;
                        } else {
                            if (inFinalThird && Math.random() < (pSpd / 100) * 0.7) {
                                if (p.y < 25) nextVy = 1.8;
                                else if (p.y > 75) nextVy = -1.8;
                                else nextVy = centerDriveVy * 1.2;

                                nextVx = dir * (pSpd / 100) * 1.3; 
                                state.eventText = "폭발적 공간 돌파!"; 
                                p.cooldown = 1; 
                            } else {
                                nextVx = dir * (pSpd / 100) * 1.0; 
                                nextVy = centerDriveVy * 0.6; 
                                state.eventText = "전진 드리블"; 
                                p.cooldown = 0; 
                            }
                        }

                        state.ball.vx = nextVx;
                        state.ball.vy = nextVy;
                    }
                }
            });

            // --- 6. 아웃 및 골 판정 ---
            if (state.phase === 'play') {
                if (state.ball.x <= 0) {
                    if (state.ball.y > 38 && state.ball.y < 62) handleGoal(room, rightTeam); 
                    else setupSetPiece(state, state.lastTouchTeam === leftTeam ? 'corner' : 'goal_kick', leftTeam);
                } 
                else if (state.ball.x >= 100) {
                    if (state.ball.y > 38 && state.ball.y < 62) handleGoal(room, leftTeam); 
                    else setupSetPiece(state, state.lastTouchTeam === rightTeam ? 'corner' : 'goal_kick', rightTeam);
                } 
                else if (state.ball.y <= 0 || state.ball.y >= 100) {
                    setupSetPiece(state, 'throw_in', state.lastTouchTeam === leftTeam ? rightTeam : leftTeam);
                }
            }

            emitUpdate(roomCode, state);

        } catch (error) {
            console.error("🔥 인게임 연산 에러 발생!:", error);
        }
    }, 100); 
} 

function handleGoal(room, scoringTeam) {
    let state = room.matchState;
    state.isPaused = true;
    state.phase = 'goal'; // ★ 핵심 방어선: 골 세리머니 중임을 명시해서 중복 골 판정을 차단!
    state.ball.vx = 0; state.ball.vy = 0;
    state.score[`team${scoringTeam}`]++;

    // 시간 계산
    let totalTicks = state.ticks;
    let gameSeconds = (totalTicks / 10) * (db.settings.gameMinutesPerHalf * 60 / db.settings.halfDurationRealSeconds);
    if (state.half === 2) gameSeconds += db.settings.gameMinutesPerHalf * 60; 
    let min = Math.floor(gameSeconds / 60);
    let sec = Math.floor(gameSeconds % 60);
    let timeStr = `${min}분 ${sec}초`;

    // 득점자 판별
    let scorerName = "자책골";
    
    // 수비수가 걷어내려다 넣었든 키퍼 손에 맞고 들어갔든, 
    // 득점한 팀(scoringTeam)의 가장 마지막 터치 선수를 득점자로 인정합니다.
    if (scoringTeam === 1 && state.lastTeam1Touch) {
        scorerName = state.lastTeam1Touch;
    } else if (scoringTeam === 2 && state.lastTeam2Touch) {
        scorerName = state.lastTeam2Touch;
    } else if (state.lastTouchTeam === scoringTeam && state.lastTouchPlayerName) {
        scorerName = state.lastTouchPlayerName;
    }

    state.eventText = `⚽ ${scorerName} 득점! (${timeStr})`;

    // 서버 로그에 기록
    if (!state.goalLog) state.goalLog = [];
    state.goalLog.push({ time: timeStr, team: scoringTeam, scorer: scorerName });

    emitUpdate(room.code, state);
    io.to(room.code).emit('playSound', 'whistle');
    
    // 알림 데이터 전송
    io.to(room.code).emit('goalScored', { 
        team: scoringTeam, 
        score: state.score,
        scorer: scorerName,
        time: timeStr
    });
    
    setTimeout(() => { 
        if(room.matchState) { 
            resetPositions(room.matchState, scoringTeam === 1 ? 2 : 1); 
            io.to(room.code).emit('playSound', 'whistle'); 
        } 
    }, 3000);
}

function setupSetPiece(state, type, sideTeam = 1) {
    state.phase = type; state.setPieceTimer = 20; state.ball.vx = 0; state.ball.vy = 0;
    
    let leftTeam = state.half === 1 ? 1 : 2;
    let rightTeam = state.half === 1 ? 2 : 1;
    let dir = sideTeam === leftTeam ? 1 : -1;

    if (type === 'throw_in') {
        state.eventText = "스로인"; state.ball.y = state.ball.y <= 0 ? 2 : 98;
        state.ball.x = Math.max(5, Math.min(95, state.ball.x)); 
        let fieldPlayers = state.players.filter(p => p.role !== 'GK');
        let thrower = fieldPlayers
            .filter(p => p.team === sideTeam)
            .reduce((prev, curr) => (getDistance(curr.x, curr.y, state.ball.x, state.ball.y) < getDistance(prev.x, prev.y, state.ball.x, state.ball.y) ? curr : prev));
        
        state.throwerId = thrower.id; state.possessionTeam = thrower.team;
        thrower.x = state.ball.x; thrower.y = state.ball.y; thrower.cooldown = 20;
    } 
    else if (type === 'corner') {
        state.eventText = "코너킥"; state.possessionTeam = sideTeam === leftTeam ? rightTeam : leftTeam;
        let attTeam = state.possessionTeam;
        let goalX = sideTeam === leftTeam ? 2 : 98; state.ball.x = goalX; state.ball.y = (state.ball.y > 50) ? 98 : 2;
        
        let kicker = state.players.find(p => p.team === attTeam && p.role === 'FW') || state.players.find(p => p.team === attTeam && p.role !== 'GK');
        if(kicker) { 
            kicker.x = state.ball.x; 
            kicker.y = state.ball.y; 
            kicker.cooldown = 20; 
            state.kickerId = kicker.id; 
        }
    }
    else if (type === 'goal_kick') {
        state.eventText = "골킥"; state.possessionTeam = sideTeam;
        let goalX = sideTeam === leftTeam ? 5 : 95; state.ball.x = goalX; state.ball.y = 50;
        
        let gk = state.players.find(p => p.team === sideTeam && p.role === 'GK');
        if(gk) { gk.x = state.ball.x; gk.y = state.ball.y; gk.cooldown = 0; } 
    }
}

function startHalfTime(roomCode) {
    const room = rooms[roomCode];
    // 🎯 방장이 설정한 하프타임 시간을 가져오고, 없으면 15초를 사용합니다.
    const htDuration = room.settings.halfTimeDuration || 15;
    
    io.to(roomCode).emit('halfTimeStarted', htDuration, room.matchState.players);
    setTimeout(() => { 
        if (rooms[roomCode]) startMatchPhase(roomCode, true); 
    }, htDuration * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
