const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let activeRooms = {};
let globalLeaderboard = {}; 

function cleanEmptyRooms() {
    for(let rId in activeRooms) {
        let r = activeRooms[rId];
        let hasPlayers = false;
        ['red', 'blue'].forEach(t => {
            for(let i=0; i<3; i++) { if(r.slots[t][i] && r.slots[t][i].type === 'player') hasPlayers = true; }
        });
        if(!hasPlayers) delete activeRooms[rId];
    }
    io.emit('update_rooms', Object.values(activeRooms));
}

io.on('connection', (socket) => {
    
    // ระบบ Global Chat
    socket.on('send_chat', (data) => {
        io.emit('receive_chat', { name: data.name, msg: data.msg });
    });

    socket.on('update_level', (data) => {
        if(data.name && data.level) {
            if(!globalLeaderboard[data.name] || globalLeaderboard[data.name] < data.level) {
                globalLeaderboard[data.name] = data.level;
            }
        }
        let sorted = Object.entries(globalLeaderboard).sort((a, b) => b[1] - a[1]).slice(0, 10);
        io.emit('leaderboard_data', sorted);
    });

    socket.on('get_rooms', () => { cleanEmptyRooms(); });

    socket.on('create_room', (data) => {
        socket.rooms.forEach(room => { if (room !== socket.id) socket.leave(room); });
        const roomId = 'R_' + Date.now();
        activeRooms[roomId] = { 
            id: roomId, name: data.name, map: data.map, 
            isPrivate: data.isPrivate, pin: data.pin, allowBots: data.allowBots,
            creator: data.creator, creatorId: socket.id, matchStarted: false,
            slots: { red: [null, null, null], blue: [null, null, null] } 
        };
        socket.join(roomId);
        socket.emit('room_created', activeRooms[roomId]);
        io.emit('update_rooms', Object.values(activeRooms));
    });

    socket.on('auto_join', (data) => {
        let r = activeRooms[data.roomId];
        if(!r) { socket.emit('error', 'Room not found.'); cleanEmptyRooms(); return; }
        if(r.matchStarted) { socket.emit('error', 'Match already started.'); return; }
        if(r.isPrivate && data.pin !== r.pin) { socket.emit('error', 'Incorrect PIN.'); return; }

        let joined = false;
        for(let t of ['blue', 'red']) {
            for(let i=0; i<3; i++) { if(!r.slots[t][i]) { r.slots[t][i] = { id: socket.id, name: data.name, type: 'player', level: data.level }; joined = true; break; } }
            if(joined) break;
        }
        if(!joined) {
            for(let t of ['blue', 'red']) {
                for(let i=0; i<3; i++) { if(r.slots[t][i] && r.slots[t][i].type === 'bot') { r.slots[t][i] = { id: socket.id, name: data.name, type: 'player', level: data.level }; joined = true; break; } }
                if(joined) break;
            }
        }

        if(joined) {
            socket.rooms.forEach(room => { if (room !== socket.id && room !== data.roomId) socket.leave(room); });
            socket.join(data.roomId); io.to(data.roomId).emit('lobby_update', r);
        } else { socket.emit('error', 'Room is full.'); }
    });

    socket.on('join_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team] && !r.matchStarted) {
            if(r.slots[data.team][data.index] && r.slots[data.team][data.index].type === 'player' && r.slots[data.team][data.index].id !== socket.id) return;
            ['red', 'blue'].forEach(t => { for(let i=0; i<3; i++) { if(r.slots[t][i] && r.slots[t][i].id === socket.id) r.slots[t][i] = null; } });
            r.slots[data.team][data.index] = { id: socket.id, name: data.name, type: 'player', level: data.level };
            socket.join(data.roomId); io.to(data.roomId).emit('lobby_update', r);
        }
    });

    socket.on('add_bot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team] && !r.matchStarted) {
            r.slots[data.team][data.index] = { id: 'BOT_' + Math.random().toString(36).substr(2, 9), name: 'BOT', type: 'bot', level: 1 };
            io.to(data.roomId).emit('lobby_update', r);
        }
    });

    socket.on('leave_room', (roomId) => { socket.leave(roomId); cleanEmptyRooms(); });

    socket.on('remove_slot', (data) => {
        let r = activeRooms[data.roomId];
        if(r && r.slots[data.team]) {
            let removedId = r.slots[data.team][data.index]?.id;
            r.slots[data.team][data.index] = null;
            if (removedId === socket.id) socket.leave(data.roomId);
            
            let isEmpty = true; let redHas = false; let blueHas = false;
            ['red', 'blue'].forEach(t => { 
                for(let i=0; i<3; i++) { 
                    if(r.slots[t][i] && r.slots[t][i].type === 'player') isEmpty = false; 
                    if(r.slots[t][i]) { if(t==='red') redHas=true; else blueHas=true; }
                } 
            });

            if(isEmpty) { delete activeRooms[data.roomId]; cleanEmptyRooms(); } 
            else { 
                if(r.matchStarted && (!redHas || !blueHas)) { r.matchStarted = false; io.to(data.roomId).emit('match_forfeit', !redHas ? 'blue' : 'red'); }
                io.to(data.roomId).emit('lobby_update', r); 
            }
        }
    });

    socket.on('start_match', (roomId) => { 
        if(activeRooms[roomId]) { activeRooms[roomId].matchStarted = true; io.to(roomId).emit('match_started', activeRooms[roomId]); }
    });

    socket.on('return_to_lobby', (roomId) => {
        let r = activeRooms[roomId];
        if(r) { r.matchStarted = false; io.to(roomId).emit('lobby_update', r); }
    });

    socket.on('player_move', (data) => { socket.to(data.roomId).emit('player_moved', { id: data.id || socket.id, x: data.x, y: data.y, angle: data.angle }); });
    socket.on('ball_hit', (data) => { socket.to(data.roomId).emit('ball_sync', data); });
    socket.on('spawn_item', (data) => { socket.to(data.roomId).emit('item_spawned', data.item); });
    socket.on('collect_item', (data) => { io.to(data.roomId).emit('item_collected', data); });
    socket.on('bump_player', (data) => { socket.to(data.roomId).emit('player_bumped', data); });

    socket.on('disconnect', () => {
        for(let rId in activeRooms) {
            let r = activeRooms[rId];
            let changed = false; let wasHost = (r.creatorId === socket.id);
            ['red', 'blue'].forEach(t => { for(let i=0; i<3; i++) { if(r.slots[t][i] && r.slots[t][i].id === socket.id) { r.slots[t][i] = null; changed = true; } } });

            if(changed) {
                let isEmpty = true; let redHas = false; let blueHas = false;
                ['red', 'blue'].forEach(t => { 
                    for(let i=0; i<3; i++) { 
                        if(r.slots[t][i] && r.slots[t][i].type === 'player') isEmpty = false; 
                        if(r.slots[t][i]) { if(t==='red') redHas=true; else blueHas=true; }
                    } 
                });
                if(isEmpty) { delete activeRooms[rId]; } 
                else { 
                    if(r.matchStarted && (!redHas || !blueHas)) { r.matchStarted = false; io.to(rId).emit('match_forfeit', !redHas ? 'blue' : 'red'); }
                    io.to(rId).emit('lobby_update', r); 
                }
            }
        }
        cleanEmptyRooms();
    });
});

server.listen(process.env.PORT || 3000);