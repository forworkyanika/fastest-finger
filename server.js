// server.js (ฉบับสมบูรณ์ที่แก้ไข Race Condition และ Rejoin แล้ว)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// จัดการ static files เช่น HTML, CSS, JS
app.use(express.static(__dirname));

let rooms = {}; // { '1234': { roomName, hostId, players[], submissions[], isGameActive, disconnectTimer } }

// --- ฟังก์ชันช่วยเหลือ ---
function generateRoomCode() {
    let code;
    do {
        // สร้างรหัส 4 หลัก
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);
    return code;
}

function isValidName(name) {
    if (!name || name.length === 0 || name.length > 20) return false;
    // อนุญาต ก-ฮ, a-z, และ space, ห้ามตัวเลข/อักษรพิเศษอื่น
    const nameRegex = /^[A-Za-zก-๙\s]+$/; 
    return nameRegex.test(name.trim()); 
}

// --- เริ่มการเชื่อมต่อ Socket ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // === 1. Host สร้างห้อง ===
    socket.on('host-create-room', (data) => {
        const roomName = data.roomName.trim();
        if (!isValidName(roomName)) {
            socket.emit('error-message', 'ชื่อห้องไม่ถูกต้อง (ต้องเป็น ก-ฮ หรือ a-z, ห้ามใช้ตัวเลข/อักษรพิเศษ, ไม่เกิน 20 ตัวอักษร)');
            return;
        }

        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            roomName: roomName,
            hostId: socket.id,
            players: [],
            submissions: [],
            isGameActive: false,
            disconnectTimer: null 
        };

        socket.join(roomCode);
        console.log(`Host created room: ${roomCode} (${roomName}) by ${socket.id}`);
        socket.emit('room-created', { roomCode, roomName });
    });

    // === 2. Host เข้าร่วม (เมื่อเปิดหน้า host.html หรือ Refresh) ===
    socket.on('host-join', (roomCode) => {
        if (rooms[roomCode]) {
            
            if (rooms[roomCode].disconnectTimer) {
                clearTimeout(rooms[roomCode].disconnectTimer); 
                rooms[roomCode].disconnectTimer = null;
                console.log(`Host reconnected in time. Room ${roomCode} saved.`);
            }

            rooms[roomCode].hostId = socket.id;
            socket.join(roomCode);
            console.log(`Host ${socket.id} connected/rejoined room ${roomCode}`);
            
            socket.emit('host-data', {
                roomName: rooms[roomCode].roomName,
                roomCode: roomCode,
                players: rooms[roomCode].players,
                submissions: rooms[roomCode].submissions,
                isGameActive: rooms[roomCode].isGameActive
            });
        } else {
            socket.emit('error-message', 'ไม่พบห้องนี้', true); 
        }
    });

    // === 3. Player เข้าร่วมห้อง ===
    socket.on('player-join-room', (data) => {
        const { roomCode, playerName } = data;
        const trimmedName = playerName.trim();

        if (!rooms[roomCode]) {
            socket.emit('error-message', 'ไม่พบรหัสห้องนี้');
            return;
        }

        if (rooms[roomCode].disconnectTimer) {
            socket.emit('error-message', 'Host กำลังเชื่อมต่อ กรุณาลองใหม่อีกครั้ง');
            return;
        }

        if (!isValidName(trimmedName)) {
            socket.emit('error-message', 'ชื่อผู้เล่นไม่ถูกต้อง (ต้องเป็น ก-ฮ หรือ a-z, ห้ามใช้ตัวเลข/อักษรพิเศษ, ไม่เกิน 20 ตัวอักษร)');
            return;
        }

        const existingPlayer = rooms[roomCode].players.find(p => p.name === trimmedName);
        if (existingPlayer) {
            socket.emit('error-message', 'มีคนใช้ชื่อนี้ในห้องแล้ว');
            return;
        }
        
        const newPlayer = { id: socket.id, name: trimmedName, fouled: false, buzzed: false };
        rooms[roomCode].players.unshift(newPlayer); 
        
        socket.join(roomCode);
        console.log(`Player ${trimmedName} joined room ${roomCode} with ID: ${socket.id}`);

        socket.emit('join-success', { playerName: trimmedName, roomName: rooms[roomCode].roomName, roomCode: roomCode });
        
        io.to(rooms[roomCode].hostId).emit('update-player-list', rooms[roomCode].players);
    });

    // === 4. เมื่อ Player เข้าหน้า Player Page (กรณี Refresh) ===
    socket.on('player-rejoin-check', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('error-message', 'ไม่พบรหัสห้องนี้', true);
            return;
        }

        const player = room.players.find(p => p.name === playerName);
        if (player) {
            player.id = socket.id; 
            socket.join(roomCode);
            console.log(`Player ${playerName} reconnected to room ${roomCode} with new ID: ${socket.id}`);
            
            socket.emit('rejoin-state', {
                roomName: room.roomName,
                playerName: playerName,
                isGameActive: room.isGameActive,
                playerState: player
            });
            io.to(room.hostId).emit('update-player-list', room.players);
        } else {
            socket.emit('error-message', 'ไม่พบชื่อผู้เล่นนี้ในห้อง', true);
        }
    });

    // === 5. Host เริ่มเกม ===
    socket.on('host-start-game', (roomCode) => {
        if (!rooms[roomCode] || rooms[roomCode].hostId !== socket.id) return;

        console.log(`Game started in room ${roomCode}`);
        rooms[roomCode].isGameActive = true;
        rooms[roomCode].players.forEach(p => { p.fouled = false; p.buzzed = false; });
        rooms[roomCode].submissions = [];

        io.to(roomCode).emit('game-started'); 
        io.to(rooms[roomCode].hostId).emit('update-submissions', rooms[roomCode].submissions);
        io.to(rooms[roomCode].hostId).emit('update-player-list', rooms[roomCode].players);
    });

    // === 6. Host รีเซ็ตเกม ===
    socket.on('host-reset-game', (roomCode) => {
        if (!rooms[roomCode] || rooms[roomCode].hostId !== socket.id) return;

        console.log(`Game reset in room ${roomCode}`);
        rooms[roomCode].isGameActive = false;
        rooms[roomCode].players.forEach(p => { p.fouled = false; p.buzzed = false; });
        rooms[roomCode].submissions = [];

        io.to(roomCode).emit('game-reset'); 
        io.to(rooms[roomCode].hostId).emit('update-submissions', rooms[roomCode].submissions);
        io.to(rooms[roomCode].hostId).emit('update-player-list', rooms[roomCode].players);
    });

    // === 7. Player กดปุ่ม ===
    socket.on('player-buzz', (roomCode) => {
        if (!rooms[roomCode]) return;
        const player = rooms[roomCode].players.find(p => p.id === socket.id);
        if (!player || player.buzzed || player.fouled) return;

        const buzzTime = new Date();
        if (!rooms[roomCode].isGameActive) {
            player.fouled = true;
            socket.emit('player-foul');
        } else {
            player.buzzed = true;
            
            // === [EDIT] แก้ไขเวลาเป็น GMT+7 (Bangkok) ===
            const options = {
                timeZone: 'Asia/Bangkok',
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            };
            const bangkokTime = buzzTime.toLocaleTimeString('th-TH', options);
            const milliseconds = buzzTime.getMilliseconds().toString().padStart(3, '0');
            // ==========================================

            rooms[roomCode].submissions.push({
                name: player.name,
                time: `${bangkokTime}.${milliseconds}` // **[EDIT]**
            });
            
            socket.emit('player-done'); 
            io.to(rooms[roomCode].hostId).emit('update-submissions', rooms[roomCode].submissions);
        }
        io.to(rooms[roomCode].hostId).emit('update-player-list', rooms[roomCode].players);
    });

    // === 8. การจัดการเมื่อผู้ใช้หลุด ===
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];

            // ตรรกะของ Host เมื่อ Disconnect
            if (room.hostId === socket.id) {
                console.log(`Host ${socket.id} disconnected from room ${roomCode}. Starting 5s close timer.`);
                
                room.disconnectTimer = setTimeout(() => {
                    if (rooms[roomCode] && rooms[roomCode].disconnectTimer) {
                        console.log(`Room ${roomCode} close timer expired. Closing room.`);
                        io.to(roomCode).emit('error-message', 'Host ไม่ได้เชื่อมต่อ... เกมสิ้นสุดลง', true);
                        delete rooms[roomCode];
                    }
                }, 5000); 
                
                break;
            }

            // ตรรกะของ Player เมื่อ Disconnect
            // (แก้ไขจากไฟล์ที่คุณอัปโหลด)
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex > -1) {
                const playerName = room.players[playerIndex].name;
                console.log(`Player ${playerName} disconnected from room ${roomCode}. Removing player.`);
                
                // ลบผู้เล่นออกจากห้องเมื่อหลุด (เพื่อให้เขากลับมา Join ใหม่ได้)
                rooms[roomCode].players.splice(playerIndex, 1);
                
                // อัปเดตรายชื่อให้ Host (ถ้า Host ยังอยู่)
                if (rooms[roomCode]) {
                    io.to(rooms[roomCode].hostId).emit('update-player-list', room.players);
                }
                break;
            }
        }
    });
});

// --- รัน Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});