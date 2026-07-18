const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let activeRooms = {};

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
        socket.rooms.forEach(room => { if (room !== socket.id) socket.leave(room); });
        
        const roomId = 'R_' + Date.now();
        activeRooms[roomId] = { 
            id: roomId, name: data.name, map: data.map, 
            isPrivate: data.isPrivate, pin: data.pin, allowBots: data.allowBots,
            creator: data.creator, creatorId: socket.id,
            matchStarted: false, // เช็คว่าเกมเริ่มไปหรือยัง
            slots: { red: [null, null, null], blue: [null, null, null] } 
        };
        socket.join(roomId);
        socket.emit('room_created', activeRooms[roomId]);
        io.emit('update_rooms', Object.values(activeRooms));
    });

    socket.on('auto_join', (data) => {
        let r = activeRooms[data.roomId];
        if(!r) {
            socket.emit('error', 'Room not found. It may have been closed.');
            socket.emit('update_rooms', Object.values(activeRooms)); 
            return;
        }
        if (r.isPrivate && data.pin !== r.pin) {
            socket.emit('error', 'Incorrect PIN. Please try again.');
            return;
        }

        let joined = false;
        for(let t of ['blue', 'red']) {
            for(let i=0; i<3; i++) {
                if(!r.slots[t][i]) {
                    r.slots[t][i] = { id: socket.id, name: data.name, type: 'player', skin: data.skin, trail: data.trail, goal: data.goal };
                    joined = true; break;
                }
            }
            if(joined) break;
        }
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
            socket.rooms.forEach(room => { if (room !== socket.id && room !== data.roomId) socket.leave(room); });
            socket.join(data.roomId);
            io.to(data.roomId).emit('lobby_update', r);
        } else {
            socket.emit('error', 'The room is currently full.');
        }
    });

    socket.on('join_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            let targetSlot = r.slots[data.team][data.index];
            if(targetSlot && targetSlot.type === 'player' && targetSlot.id !== socket.id) return;
            ['red', 'blue'].forEach(t => {
                for(let i=0; i<3; i++) { if(r.slots[t][i] && r.slots[t][i].id === socket.id) r.slots[t][i] = null; }
            });
            r.slots[data.team][data.index] = { id: socket.id, name: data.name, type: 'player', skin: data.skin, trail: data.trail, goal: data.goal };
            socket.join(data.roomId);
            io.to(data.roomId).emit('lobby_update', r);
        }
    });

    socket.on('add_bot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            r.slots[data.team][data.index] = { id: 'BOT_' + Math.random().toString(36).substr(2, 9), name: 'BOT', type: 'bot', skin: data.skin, trail: data.trail, goal: data.goal };
            io.to(data.roomId).emit('lobby_update', r);
        }
    });

    socket.on('leave_room', (roomId) => { socket.leave(roomId); });

    socket.on('remove_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            let removedId = r.slots[data.team][data.index]?.id;
            r.slots[data.team][data.index] = null;
            
            // เตะวิญญาณออกจากหน้าจอเพื่อนเวลาคนกดออกกลางเกม!
            if (r.matchStarted && removedId) {
                io.to(data.roomId).emit('player_left_midgame', removedId);
            }

            if (removedId === socket.id) { socket.leave(data.roomId); } 
            else if (removedId) {
                let targetSocket = io.sockets.sockets.get(removedId);
                if (targetSocket) targetSocket.leave(data.roomId);
            }
            if(removedId === r.creatorId) reassignHost(r);
            
            let isEmpty = true;
            ['red', 'blue'].forEach(t => {
                for(let i=0; i<3; i++) { if(r.slots[t][i] && r.slots[t][i].type === 'player') isEmpty = false; }
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
        if(activeRooms[roomId]) {
            activeRooms[roomId].matchStarted = true;
            io.to(roomId).emit('match_started', activeRooms[roomId]); 
        }
    });

    // ให้คนที่มาทีหลัง ขอกดเกิดกลางเกมได้!
    socket.on('request_midgame_spawn', (roomId) => {
        let r = activeRooms[roomId];
        if(r && r.matchStarted) {
            let sData = null; let sTeam = null; let sIdx = 0;
            ['red','blue'].forEach(t => {
                for(let i=0; i<3; i++) {
                    if(r.slots[t][i] && r.slots[t][i].id === socket.id) { sData = r.slots[t][i]; sTeam = t; sIdx = i; }
                }
            });
            if(sData) {
                io.to(roomId).emit('spawn_midgame_player', { team: sTeam, index: sIdx, player: sData });
            }
        }
    });

    socket.on('player_move', (data) => { socket.to(data.roomId).emit('player_moved', { id: data.id || socket.id, x: data.x, y: data.y, angle: data.angle }); });
    socket.on('ball_hit', (data) => { socket.to(data.roomId).emit('ball_sync', data); });
    socket.on('spawn_item', (data) => { socket.to(data.roomId).emit('item_spawned', data.item); });
    socket.on('collect_item', (data) => { io.to(data.roomId).emit('item_collected', data); });
    socket.on('bump_player', (data) => { socket.to(data.roomId).emit('player_bumped', data); });

    socket.on('disconnect', () => {
        console.log('💀 PLAYER DISCONNECTED:', socket.id);
        for(let rId in activeRooms) {
            let r = activeRooms[rId];
            let changed = false;
            let wasHost = (r.creatorId === socket.id);
            ['red', 'blue'].forEach(t => {
                for(let i=0; i<3; i++) {
                    if(r.slots[t][i] && r.slots[t][i].id === socket.id) { r.slots[t][i] = null; changed = true; }
                }
            });

            if(changed) {
                // ถ้าเกมเริ่มไปแล้ว ให้เตะศพออกจากหน้าจอเพื่อนด้วย
                if(r.matchStarted) io.to(rId).emit('player_left_midgame', socket.id);

                let isEmpty = true;
                ['red', 'blue'].forEach(t => {
                    for(let i=0; i<3; i++) { if(r.slots[t][i] && r.slots[t][i].type === 'player') isEmpty = false; }
                });

                if(isEmpty) { delete activeRooms[rId]; io.emit('update_rooms', Object.values(activeRooms)); } 
                else { if(wasHost) reassignHost(r); io.to(rId).emit('lobby_update', r); }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 SERVER IO IS RUNNING ON PORT: ${PORT}`); });