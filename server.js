require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const Group = require('./models/Group');

const app = express();
const server = require('http').createServer(app);

// Initialize Socket.io
const io = socketIo(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    }
});

// Expose io to routes
app.set('io', io);

// Socket.io JWT Authentication Middleware
const jwt = require('jsonwebtoken');
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        if (!token) return next(new Error('Authentication error'));        
        // Ensure to remove "Bearer " if included
        const cleanToken = token.replace('Bearer ', '');
        const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET);
        socket.user = decoded.user;
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

// Socket.io Connection Management
const activeUsers = new Map();

const revokeHiveAccessForUser = (userId, hiveId = null) => {
    const socket = activeUsers.get(userId);
    if (!socket) return;

    const targetHives = hiveId ? [hiveId] : Array.from(socket.joinedHives || []);

    targetHives.forEach((roomId) => {
        socket.leave(roomId);
    });

    if (socket.joinedHives) {
        targetHives.forEach((roomId) => socket.joinedHives.delete(roomId));
    }

    if (hiveId) {
        socket.emit('hive_access_revoked', { hiveId });
    }
};

app.set('activeUsers', activeUsers);
app.set('revokeHiveAccessForUser', revokeHiveAccessForUser);

io.on('connection', (socket) => {
    const userId = socket.user.id;
    socket.joinedHives = new Set();

    // Strict 1-Socket-Per-User Rule
    if (activeUsers.has(userId)) {
        // console.log(`User ${userId} opened new connection, dropping old socket to prevent flooding.`);
        activeUsers.get(userId).disconnect();
    }
    activeUsers.set(userId, socket);

    // Join isolated Hive Room with Security Check
    socket.on('join_hive', async (hiveId) => {
        try {
            const group = await Group.findById(hiveId);
            if (!group) return;

            // Strict Validation: Is the user actually a member?
            const isMember = group.members.some(memberId => memberId.toString() === userId);

            if (isMember) {
                socket.join(hiveId);
                socket.joinedHives.add(hiveId);
                // console.log(`User ${userId} joined room: ${hiveId}`);
            } else {
                console.log(`SECURITY WARNING : User ${userId} tried to join unauthorized room ${hiveId}`);
            }
        } catch (err) {
            console.error(err);
        }
    });

    // Leave isolated Hive Room
    socket.on('leave_hive', (hiveId) => {
        if (hiveId) {
            socket.leave(hiveId);
            socket.joinedHives.delete(hiveId);
        }
        // console.log(`User ${userId} left room: ${hiveId}`);
    });
    socket.on('disconnect', () => {
        activeUsers.delete(userId);
        socket.joinedHives?.clear();
        // console.log(`Socket disconnected: User ${userId}`);
    });
});

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// --- Security & Standard Middleware ---

// 1. Hardened CORS (Must come first to handle preflights)
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

// 2. HTTP Header protection
app.use(helmet());

// 3. Global Rate Limiter (Max 200 requests per 15 mins)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { msg: "Too many requests from this IP, please try again later." },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api', apiLimiter);

// 4. Payload format & size limit protection (Body Parser)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

// --- Database Connection (Placeholder for now) ---
const connectDB = async () => {
    try {
        // We will add the connection string later
        await mongoose.connect(process.env.mongoURL);
        console.log('MongoDB connection ready...');
    } catch (error) {
        console.error('Database connection failed:', error);
        process.exit(1);
    }
};
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dumps', require('./routes/dumps'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/groups', require('./routes/groups'));

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'meme.html'));
});

// Catch-all for any other unmatched requests (404 handler)
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', 'meme.html'));
});

// --- Server Startup ---
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
    connectDB();
    // conceptCheck();
    console.log(`Server running on port ${PORT}`);
});