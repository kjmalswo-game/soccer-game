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
    state.isPaused = false;
    state.players.forEach(p => { 
        p.x = p.baseX; p.y = p.baseY; p.cooldown = 0; 
        p.mentalState = Math.random(); // ★ 각 선수마다 고유한 기분(변칙성) 부여
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

// [소켓 로직은 동일하므로 생략 - 이전 버전과 호환]
io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = { players: { [socket.id]: { id: 'player1', ready: false, team: [] } }, settings: { timer: db.settings.draftTimers[1], formation: null }, state: 'lobby', availablePlayers: [...db.players] };
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
    socket.on('setTimer', (roomCode, timerValue) => { if (rooms[roomCode]) { rooms[roomCode].settings.timer = timerValue; socket.to(roomCode).emit('timerUpdated', timerValue); } });
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
        if (isP1) room.currentDraft.p1Placed = true; else room.currentDraft.p2Placed = true;
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

function startMatchPhase(roomCode, isSecondHalf = false) {
    const room = rooms[roomCode];
    room.state = 'match';
    
    // [중략: 초기 상태 설정 부분은 이전 버전과 동일하게 유지]
    // (초기화 로직은 그대로 사용하되 AI 로직만 대폭 수정합니다)

    room.matchInterval = setInterval(() => {
        const state = room.matchState;
        if (state.isPaused) return; 
        state.ticks++;

        // --- ★ [핵심] 매 시퀀스마다 변칙성 부여 ---
        let randomness = Math.random(); // 전체적인 경기 템포 변수

        // [중략: 물리 및 세트피스 로직 유지]

        state.players.forEach(p => {
            if (p.cooldown > 0) p.cooldown--;
            
            // ★ 전술적 변칙성 부여: 포지션 고정 탈피
            let flexibility = Math.random() > 0.8 ? 20 : 0; // 20% 확률로 포지션 이탈/침투
            let targetX = p.baseX + (Math.random()-0.5)*flexibility;
            let targetY = p.baseY + (Math.random()-0.5)*flexibility;
            
            // [압박/수비 로직]
            let rank = 0; // (랭크 계산 생략)
            let isPressing = (rank === 0 || (rank < 2 && Math.random() > 0.5)); 
            
            // [패스/드리블 결정 로직]
            if (distToBallAct < 3 && p.cooldown === 0 && state.phase === 'play') {
                // 30% 확률로 무조건 드리블, 70% 확률로 패스/슛 판단
                if (Math.random() > 0.7) {
                    // 드리블: 빈 공간 찾아가기
                    state.ball.vx = (Math.random()-0.5) * 4;
                    state.ball.vy = (Math.random()-0.5) * 4;
                } else {
                    // 패스: 전진성 가중치 적용
                    // (이하 패스 로직 구현)
                }
            }
        });
        
        emitUpdate(roomCode, state);
    }, 100); 
}
