/**
 * JO SOCIO - CORE ENGINE (STEP 3: ADVANCED INSTANT MESSAGING)
 * Messagerie temps réel : Groupes, Notes vocales, Accusés de lecture précis ("Vu à..."), et Réactions
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "INSTA_ENTERPRISE_SECRET_KEY_2026_PROD";
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

if (!fsSync.existsSync(UPLOADS_DIR)) fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });

// STRUCTURE DE BD ENRICHIE AVEC LES GROUPES ("conversations")
let db = { users: [], posts: [], messages: [], conversations: [], notifications: [], statuses: [] };

const initDB = async () => {
    try {
        if (fsSync.existsSync(DATA_FILE)) {
            const data = await fs.readFile(DATA_FILE, 'utf8');
            db = JSON.parse(data || '{"users":[],"posts":[],"messages":[],"conversations":[],"notifications":[],"statuses":[]}');
            if (!db.conversations) db.conversations = [];
        }
    } catch (err) { console.error("⚠️ Erreur DB", err); }
};
initDB();

const saveDB = async () => {
    try { await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); } 
    catch (err) { console.error("❌ Erreur écriture", err); }
};

// --- MIDDLEWARES & STORAGE ---
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const authMiddleware = ((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ erreur: "Non autorisé" });
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        const user = db.users.find(u => u._id === decoded.id);
        if (!user) return res.status(403).json({ erreur: "Compte introuvable" });
        req.user = user;
        next();
    } catch (err) { res.status(403).json({ erreur: "Token expiré" }); }
});

const declarerNotification = async (toId, fromUser, type, targetId = null, extraData = null) => {
    if (toId === fromUser._id) return;
    const newNotif = {
        _id: crypto.randomUUID(),
        toId, fromId: fromUser._id, fromPseudo: fromUser.pseudo, fromAvatar: fromUser.avatarUrl,
        type, targetId, extraData, read: false, date: new Date().toISOString()
    };
    db.notifications.push(newNotif);
    await saveDB();
    io.to(toId).emit('newNotification', newNotif);
};

// ==========================================
// --- MODULE MESSAGERIE AVANCÉE & GROUPES ---
// ==========================================

/**
 * 1. Créer ou récupérer une conversation (Privée ou Groupe)
 */
app.post('/conversations', authMiddleware, async (req, res) => {
    const { participantIds, isGroup, groupName } = req.body;
    
    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
        return res.status(400).json({ erreur: "Participants requis." });
    }

    // Inclure l'utilisateur connecté dans les participants
    const allParticipants = Array.from(new Set([...participantIds, req.user._id]));

    // Si c'est une conversation privée (1v1), vérifier si elle existe déjà
    if (!isGroup && allParticipants.length === 2) {
        const existingConv = db.conversations.find(c => 
            !c.isGroup && 
            c.participants.length === 2 && 
            c.participants.every(id => allParticipants.includes(id))
        );
        if (existingConv) return res.json(existingConv);
    }

    // Création d'une nouvelle conversation
    const newConv = {
        _id: crypto.randomUUID(),
        isGroup: !!isGroup,
        name: isGroup ? (groupName || "Nouveau Groupe") : null,
        adminId: isGroup ? req.user._id : null,
        participants: allParticipants,
        lastMessage: null,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
    };

    db.conversations.push(newConv);
    await saveDB();

    // Avertir tous les membres du groupe via Socket
    allParticipants.forEach(userId => {
        io.to(userId).emit('newConversation', newConv);
    });

    res.status(201).json(newConv);
});

/**
 * 2. Récupérer la liste de ses conversations triées par date du dernier message
 */
app.get('/conversations', authMiddleware, (req, res) => {
    const mesConvs = db.conversations
        .filter(c => c.participants.includes(req.user._id))
        .map(conv => {
            // Enrichir avec les profils des participants pour l'affichage
            const profils = db.users
                .filter(u => conv.participants.includes(u._id) && u._id !== req.user._id)
                .map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl }));
            
            // Calculer le nombre de messages non lus pour l'utilisateur
            const unreadCount = db.messages.filter(m => 
                m.conversationId === conv._id && 
                m.fromId !== req.user._id && 
                (!m.readBy || !m.readBy.some(r => r.userId === req.user._id))
            ).length;

            return {
                ...conv,
                displayProfiles: profils,
                unreadCount
            };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json(mesConvs);
});

/**
 * 3. Récupérer l'historique d'une conversation avec statut de lecture précis
 */
app.get('/conversations/:id/messages', authMiddleware, (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) {
        return res.status(403).json({ erreur: "Accès refusé à cette conversation." });
    }

    const limit = parseInt(req.query.limit) || 50;
    const msgs = db.messages
        .filter(m => m.conversationId === conv._id)
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(-limit);

    res.json(msgs);
});

/**
 * 4. Envoyer un message (Texte, Note Vocale, Image ou Vidéo)
 */
app.post('/conversations/:id/messages', authMiddleware, upload.single('media'), async (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) {
        return res.status(403).json({ erreur: "Accès refusé." });
    }

    if (!req.body.texte && !req.file) return res.status(400).json({ erreur: "Message vide impossible." });

    // Déterminer précisément le type de média (ex: note vocale vs musique standard)
    let mediaType = 'text';
    if (req.file) {
        if (req.file.mimetype.startsWith('audio')) mediaType = 'audio'; // Note vocale
        else if (req.file.mimetype.startsWith('video')) mediaType = 'video';
        else mediaType = 'image';
    }

    const newMsg = {
        _id: crypto.randomUUID(),
        conversationId: conv._id,
        fromId: req.user._id,
        fromPseudo: req.user.pseudo,
        fromAvatar: req.user.avatarUrl,
        texte: req.body.texte || "",
        mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
        mediaType,
        duration: req.body.duration ? parseInt(req.body.duration) : null, // Durée en secondes pour l'audio/vocale
        reactions: [], // Emojis sur le message : [{ userId, emoji }]
        status: 'sent',
        // Tableau pour gérer le "Vu par" en groupe ou en 1v1 avec horodatage exact
        readBy: [{ userId: req.user._id, readAt: new Date().toISOString() }],
        date: new Date().toISOString()
    };

    db.messages.push(newMsg);
    
    // Mettre à jour la conversation
    conv.lastMessage = {
        texte: mediaType === 'audio' ? "🎤 Note vocale" : (newMsg.texte || "📷 Média"),
        fromId: req.user._id,
        date: newMsg.date
    };
    conv.updatedAt = newMsg.date;
    await saveDB();

    // Diffusion WebSocket en temps réel à tous les participants
    conv.participants.forEach(userId => {
        io.to(userId).emit('newMessage', newMsg);
        io.to(userId).emit('conversationUpdated', conv);
    });

    res.status(201).json(newMsg);
});

/**
 * 5. Accusé de lecture "Vu à..." (Fonctionne en 1v1 et en Groupe)
 */
app.post('/conversations/:id/read', authMiddleware, async (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) return res.status(403).json({ erreur: "Refusé" });

    const maintenant = new Date().toISOString();
    let updated = false;

    // Marquer tous les messages non lus de la conversation avec un horodatage exact
    db.messages
        .filter(m => m.conversationId === conv._id && !m.readBy.some(r => r.userId === req.user._id))
        .forEach(m => {
            m.readBy.push({ userId: req.user._id, readAt: maintenant });
            // En 1v1, si l'autre a lu, le statut passe à 'read'
            if (!conv.isGroup) m.status = 'read';
            updated = true;
        });

    if (updated) {
        await saveDB();
        // Avertir l'expéditeur et les membres du groupe que les messages ont été vus
        conv.participants.forEach(userId => {
            if (userId !== req.user._id) {
                io.to(userId).emit('messagesRead', {
                    conversationId: conv._id,
                    readByUserId: req.user._id,
                    readByPseudo: req.user.pseudo,
                    readAt: maintenant, // Permet d'afficher "Vu à 14h02" sur le client !
                    formattedTime: new Date(maintenant).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
            }
        });
    }

    res.json({ success: true, readAt: maintenant });
});

/**
 * 6. Réagir à un message avec un Emoji (ex: ❤️, 😂, 👍)
 */
app.post('/messages/:id/react', authMiddleware, async (req, res) => {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ erreur: "Emoji requis." });

    const msg = db.messages.find(m => m._id === req.params.id);
    if (!msg) return res.status(404).json({ erreur: "Message introuvable." });

    const conv = db.conversations.find(c => c._id === msg.conversationId);
    if (!conv || !conv.participants.includes(req.user._id)) return res.status(403).json({ erreur: "Refusé" });

    if (!msg.reactions) msg.reactions = [];
    const existingIndex = msg.reactions.findIndex(r => r.userId === req.user._id);

    // Si on clique sur le même emoji, on l'enlève (toggle), sinon on met à jour
    if (existingIndex !== -1) {
        if (msg.reactions[existingIndex].emoji === emoji) {
            msg.reactions.splice(existingIndex, 1);
        } else {
            msg.reactions[existingIndex].emoji = emoji;
        }
    } else {
        msg.reactions.push({ userId: req.user._id, pseudo: req.user.pseudo, emoji });
    }

    await saveDB();

    // Notifier la réaction en direct via WebSocket
    conv.participants.forEach(userId => {
        io.to(userId).emit('messageReactionUpdated', { messageId: msg._id, reactions: msg.reactions });
    });

    res.json({ reactions: msg.reactions });
});

// ==========================================
// --- MOTEUR TEMPS RÉEL (WEBSOCKETS ADVANCED) ---
// ==========================================

io.use((socket, next) => {
    try {
        const decoded = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
        socket.user = db.users.find(u => u._id === decoded.id);
        if (!socket.user) return next(new Error("User not found"));
        next();
    } catch (err) { next(new Error("Auth Error")); }
});

io.on('connection', (socket) => {
    // Rejoindre sa propre room pour les notifications privées
    socket.join(socket.user._id);
    
    // Rejoindre automatiquement les rooms de toutes ses conversations (Groupes + 1v1)
    db.conversations
        .filter(c => c.participants.includes(socket.user._id))
        .forEach(c => socket.join(`conv_${c._id}`));

    io.emit('userStatusChange', { userId: socket.user._id, status: 'online' });

    // Événement : L'utilisateur est en train d'écrire ou d'enregistrer une note vocale
    socket.on('typing', ({ conversationId, isAudio }) => {
        socket.to(`conv_${conversationId}`).emit('userTyping', {
            userId: socket.user._id,
            pseudo: socket.user.pseudo,
            conversationId,
            action: isAudio ? "enregistre un audio..." : "écrit un message..."
        });
    });

    socket.on('stopTyping', (conversationId) => {
        socket.to(`conv_${conversationId}`).emit('userStoppedTyping', {
            userId: socket.user._id,
            conversationId
        });
    });
    
    socket.on('disconnect', () => {
        io.emit('userStatusChange', { userId: socket.user._id, status: 'offline', lastSeen: new Date().toISOString() });
    });
});

server.listen(PORT, () => console.log(`🚀 Moteur Messagerie Avancée (Étape 3) sur le port ${PORT}`));