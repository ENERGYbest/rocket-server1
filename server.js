const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let activeRooms = {};

// ฟังก์ชั่นสืบทอดมรดกโฮสต์ (ถ้าโฮสต์หนี ให้คนอื่นเป็นแทน)
function reassignHost(r) {
    let newHostFound = false;
    ['red', 'blue'].forEach(t => {
        for(let i=0; i<3; i++) {
            if(r.slots[t][i] && r.slots[t][i].type === 'player') {
                r.creatorId = r.slots[t][i].id;
                r.creator = r.slots[t][i].name;
                newHostFound = true;
                break;
            }
        }
        if(newHostFound) return;
    });
}

io.on('connection', (socket) => {
    console.log('🔥 PLAYER CONNECTED:', socket.id);

    socket.on('get_rooms', () => {
        socket.emit('update_rooms', Object.values(activeRooms));
    });

    socket.on('create_room', (data) => {
        const roomId = 'R_' + Date.now();
        activeRooms[roomId] = { 
            id: roomId, 
            name: data.name, 
            map: data.map, 
            isPrivate: data.isPrivate,
            pin: data.pin,
            allowBots: data.allowBots,
            creator: data.creator,
            creatorId: socket.id,
            slots: { red: [null, null, null], blue: [null, null, null] } 
        };
        socket.join(roomId);
        socket.emit('room_created', activeRooms[roomId]);
        io.emit('update_rooms', Object.values(activeRooms));
    });

    // แก้บัคแย่งเก้าอี้ดนตรี & บัคหมุนติ้วๆ
    socket.on('auto_join', (data) => {
        let r = activeRooms[data.roomId];
        // ถ้าหาห้องไม่เจอ (ห้องผีหลอก) ให้ด่ากลับไป! หน้าเว็บจะได้เลิกหมุน
        if(!r) {
            socket.emit('error', 'ROOM NOT FOUND (ห้องโดนยุบไปแล้วย่ะคุณน้า!)');
            socket.emit('update_rooms', Object.values(activeRooms)); // อัปเดตหน้าล็อบบี้ใหม่ด้วย
            return;
        }

        // เช็ครหัสผ่าน ถ้าห้องล็อคแล้วรหัสผิด ก็เด้งด่ากลับไป!
        if (r.isPrivate && data.pin !== r.pin) {
            socket.emit('error', 'INCORRECT PIN (รหัสผิดย่ะ ไปจำมาใหม่!)');
            return;
        }

        let joined = false;
        
        // หาช่องว่างที่ไม่มีคนก่อน
        for(let t of ['blue', 'red']) {
            for(let i=0; i<3; i++) {
                if(!r.slots[t][i]) {
                    r.slots[t][i] = { id: socket.id, name: data.name, type: 'player', skin: data.skin, trail: data.trail, goal: data.goal };
                    joined = true; break;
                }
            }
            if(joined) break;
        }
        
        // ถ้าเต็มแล้ว ลองเตะบอทออกเพื่อเสียบแทน
        if(!joined) {
            for(let t of ['blue', 'red']) {
                for(let i=0; i<3; i++) {
                    if(r.slots[t][i] && r.slots[t][i].type === 'bot') {
                        r.slots[t][i] = { id: socket.id, name: data.name, type: 'player', skin: data.skin, trail: data.trail, goal: data.goal };
                        joined = true; break;
                    }
                }
                if(joined) break;
            }
        }

        if(joined) {
            socket.join(data.roomId);
            io.to(data.roomId).emit('lobby_update', r);
        } else {
            socket.emit('error', 'ROOM IS FULL (ห้องเต็มแล้วย่ะ!)');
        }
    });

    socket.on('join_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            let targetSlot = r.slots[data.team][data.index];
            if(targetSlot && targetSlot.type === 'player' && targetSlot.id !== socket.id) return;

            ['red', 'blue'].forEach(t => {
                for(let i=0; i<3; i++) {
                    if(r.slots[t][i] && r.slots[t][i].id === socket.id) r.slots[t][i] = null;
                }
            });
            r.slots[data.team][data.index] = { 
                id: socket.id, name: data.name, type: 'player', 
                skin: data.skin, trail: data.trail, goal: data.goal 
            };
            socket.join(data.roomId);
            io.to(data.roomId).emit('lobby_update', r);
        }
    });

    socket.on('add_bot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            r.slots[data.team][data.index] = { 
                id: 'BOT_' + Math.random().toString(36).substr(2, 9), 
                name: 'BOT', type: 'bot', 
                skin: data.skin, trail: data.trail, goal: data.goal 
            };
            io.to(data.roomId).emit('lobby_update', r);
        }
    });

    // แก้บัคห้องร้าง เวลาคนกด Leave Lobby
    socket.on('remove_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            let removedId = r.slots[data.team][data.index]?.id;
            r.slots[data.team][data.index] = null;
            
            if(removedId === r.creatorId) reassignHost(r);
            
            // เช็คว่าห้องว่างมั้ย ถ้าว่างก็ทุบทิ้งไปเลย!
            let isEmpty = true;
            ['red', 'blue'].forEach(t => {
                for(let i=0; i<3; i++) {
                    if(r.slots[t][i] && r.slots[t][i].type === 'player') isEmpty = false;
                }
            });

            if(isEmpty) {
                delete activeRooms[data.roomId];
                io.emit('update_rooms', Object.values(activeRooms));
            } else {
                io.to(data.roomId).emit('lobby_update', r);
            }
        }
    });

    socket.on('start_match', (roomId) => {
        if(activeRooms[roomId]) io.to(roomId).emit('match_started', activeRooms[roomId]);
    });

    socket.on('player_move', (data) => {
        socket.to(data.roomId).emit('player_moved', { 
            id: data.id || socket.id, x: data.x, y: data.y, angle: data.angle 
        });
    });

    socket.on('ball_hit', (data) => {
        socket.to(data.roomId).emit('ball_sync', data);
    });

    // เช็คห้องร้างเวลาคนดึงปลั๊กเน็ตหลุด (Disconnect)
    socket.on('disconnect', () => {
        console.log('💀 PLAYER DISCONNECTED:', socket.id);
        for(let rId in activeRooms) {
            let r = activeRooms[rId];
            let changed = false;
            let wasHost = (r.creatorId === socket.id);

            ['red', 'blue'].forEach(t => {
                for(let i=0; i<3; i++) {
                    if(r.slots[t][i] && r.slots[t][i].id === socket.id) {
                        r.slots[t][i] = null;
                        changed = true;
                    }
                }
            });

            if(changed) {
                let isEmpty = true;
                ['red', 'blue'].forEach(t => {
                    for(let i=0; i<3; i++) {
                        if(r.slots[t][i] && r.slots[t][i].type === 'player') isEmpty = false;
                    }
                });

                if(isEmpty) {
                    delete activeRooms[rId];
                    io.emit('update_rooms', Object.values(activeRooms));
                } else {
                    if(wasHost) reassignHost(r); 
                    io.to(rId).emit('lobby_update', r);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 SERVER IO IS RUNNING ON PORT: ${PORT}`);
});