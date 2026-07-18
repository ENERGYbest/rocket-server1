const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let activeRooms = {};

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

    socket.on('join_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
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

    socket.on('remove_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            r.slots[data.team][data.index] = null;
            io.to(data.roomId).emit('lobby_update', r);
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

    socket.on('disconnect', () => {
        console.log('💀 PLAYER DISCONNECTED:', socket.id);
        for(let rId in activeRooms) {
            let r = activeRooms[rId];
            let changed = false;
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