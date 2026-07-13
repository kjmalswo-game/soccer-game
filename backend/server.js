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

    function startMatchPhase(roomCode) {
        const room = rooms[roomCode];
        room.state = 'match';
        room.matchTime = 0; 
        
        // --- 킥오프 좌표 계산 로직 시작 ---
        const playerIds = Object.keys(room.players);
        const p1Data = room.players[playerIds[0]];
        const p2Data = room.players[playerIds[1]];

        const p1Formation = db.formations[p1Data.formation].positions;
        const p2Formation = db.formations[p2Data.formation].positions;

        // 양 팀 선수들에게 풀코트 기준 초기 X, Y 좌표를 부여합니다.
        const matchState = {
            team1: p1Data.team.map(t => {
                const pos = p1Formation[t.slot];
                return { 
                    ...t.player, 
                    team: 1, 
                    x: pos.x / 2,       // 반코트(100)를 풀코트(50)로 축소
                    y: pos.y 
                }; 
            }),
            team2: p2Data.team.map(t => {
                const pos = p2Formation[t.slot];
                return { 
                    ...t.player, 
                    team: 2, 
                    x: 100 - (pos.x / 2), // 오른쪽으로 밀어내고 좌우 반전
                    y: 100 - pos.y        // 상하 반전 (180도 회전)
                }; 
            })
        };

        // 계산된 초기 좌표와 함께 클라이언트들에게 매치 시작을 알립니다.
        io.to(roomCode).emit('matchStarted', matchState);
        // --- 킥오프 좌표 계산 로직 끝 ---

        room.matchInterval = setInterval(() => {
            room.matchTime++;
            const gameMinute = Math.floor((room.matchTime / db.settings.halfDurationRealSeconds) * db.settings.gameMinutesPerHalf);
            
            // 이벤트 확률 계산
            const totalWeight = db.matchEvents.reduce((sum, e) => sum + e.weight, 0);
            let rand = Math.random() * totalWeight;
            let eventType = "오픈 플레이";
            for (let e of db.matchEvents) {
                if (rand < e.weight) { eventType = e.type; break; }
                rand -= e.weight;
            }

            io.to(roomCode).emit('matchUpdate', {
                time: room.matchTime,
                gameMinute: gameMinute,
                event: eventType
                // 추후 이 부분에 변경되는 좌표 데이터를 넣을 예정입니다.
            });

            if (room.matchTime === db.settings.halfDurationRealSeconds) {
                clearInterval(room.matchInterval);
                startHalfTime(roomCode);
            }
        }, 1000); 
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
