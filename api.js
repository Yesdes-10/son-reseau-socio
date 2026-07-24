/**
 * ============================================================================
 * JO SOCIO - ENTERPRISE PRODUCTION API & WEBSOCKET ENGINE
 * Architecture propre, sécurisée et optimisée pour Mobile (Android/iOS) & Web
 * ============================================================================
 */

require('dotenv').config();
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
const cors = require('cors');

// ============================================================================
// 1. INITIALISATION DU SERVEUR & DES CHEMINS
// ============================================================================

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "INSTA_PROD_CLUSTER_SECRET_2026_SUPER_SAFE";
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ============================================================================
// 2. GESTION DU STOCKAGE JSON (BASE DE DONNÉES)
// ============================================================================

let db = { 
    users: [], 
    posts: [], 
    messages: [], 
    conversations: [], 
    notifications: [], 
    statuses: [] 
};

const initDB = async () => {
    try {
        if (fsSync.existsSync(DATA_FILE)) {
            const data = await fs.readFile(DATA_FILE, 'utf8');
            const parsed = JSON.parse(data || '{}');
            db = {
                users: parsed.users || [],
                posts: parsed.posts || [],
                messages: parsed.messages || [],
                conversations: parsed.conversations || [],
                notifications: parsed.notifications || [],
                statuses: parsed.statuses || []
            };
        } else {
            await saveDB();
        }
    } catch (err) {
        console.error("⚠️ [Erreur DB] Lecture impossible :", err);
    }
};
initDB();

const saveDB = async () => {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (err) {
        console.error("❌ [Erreur DB] Écriture impossible :", err);
    }
};

// ============================================================================
// 3. MIDDLEWARES & STORAGE MULTER
// ============================================================================

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
        cb(null, `${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
    }
});

const upload = multer({ 
    storage, 
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|webm|mp3|wav|ogg/;
        if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) {
            return cb(null, true);
        }
        cb(new Error("Format de fichier non pris en charge."));
    }
});

const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ erreur: "Token manquant." });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.users.find(u => u._id === decoded.id);
        if (!user) return res.status(403).json({ erreur: "Compte introuvable." });
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ erreur: "Token invalide." });
    }
};

// ============================================================================
// 4. OUTILS UTILITAIRES & NOTIFICATIONS
// ============================================================================

const extraireHashtags = (texte = "") => (texte.match(/#[a-zA-Z0-9_]+/g) || []).map(t => t.toLowerCase());
const extraireMentions = (texte = "") => (texte.match(/@[a-zA-Z0-9_]+/g) || []).map(m => m.substring(1).toLowerCase());

const supprimerFichierPhysique = async (fileUrl) => {
    if (!fileUrl) return;
    try {
        const filePath = path.join(UPLOADS_DIR, path.basename(fileUrl));
        if (fsSync.existsSync(filePath)) await fs.unlink(filePath);
    } catch (err) {
        console.error(`⚠️ Erreur suppression fichier:`, err);
    }
};

const declarerNotification = async (toId, fromUser, type, targetId = null, extraData = null) => {
    if (toId === fromUser._id) return;
    const newNotif = {
        _id: crypto.randomUUID(),
        toId, fromId: fromUser._id, fromPseudo: fromUser.pseudo, fromAvatar: fromUser.avatarUrl,
        type, targetId, extraData, read: false, date: new Date().toISOString()
    };
    db.notifications.unshift(newNotif);
    await saveDB();
    io.to(toId).emit('newNotification', newNotif);
};

// ============================================================================
// 5. ROUTES AUTHENTIFICATION & UTILISATEURS
// ============================================================================

app.post('/auth/inscription', async (req, res) => {
    try {
        const { pseudo, password } = req.body;
        if (!pseudo || !password || pseudo.trim().length < 3 || password.length < 6) {
            return res.status(400).json({ erreur: "Pseudo (3 car. min) et mot de passe (6 car. min) requis." });
        }
        const cleanPseudo = pseudo.trim();
        if (db.users.some(u => u.pseudo.toLowerCase() === cleanPseudo.toLowerCase())) {
            return res.status(400).json({ erreur: "Ce pseudo est déjà pris." });
        }

        const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
        const newUser = {
            _id: crypto.randomUUID(), pseudo: cleanPseudo, password: hashedPassword,
            avatarUrl: null, bio: "", isPrivate: false,
            following: [], followers: [], followRequests: [], blockedUsers: [], bookmarks: [],
            createdAt: new Date().toISOString()
        };
        db.users.push(newUser);
        await saveDB();
        const token = jwt.sign({ id: newUser._id }, JWT_SECRET, { expiresIn: '14d' });
        res.status(201).json({ token, _id: newUser._id, pseudo: newUser.pseudo });
    } catch (err) { res.status(500).json({ erreur: "Erreur serveur." }); }
});

app.post('/auth/connexion', async (req, res) => {
    try {
        const { pseudo, password } = req.body;
        const user = db.users.find(u => u.pseudo.toLowerCase() === pseudo?.trim().toLowerCase());
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ erreur: "Identifiants incorrects." });
        }
        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '14d' });
        res.json({ token, _id: user._id, pseudo: user.pseudo, avatarUrl: user.avatarUrl });
    } catch (err) { res.status(500).json({ erreur: "Erreur de connexion." }); }
});

app.get('/users/me', authMiddleware, (req, res) => {
    const mesPosts = db.posts.filter(p => p.auteurId === req.user._id).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({
        _id: req.user._id, pseudo: req.user.pseudo, avatarUrl: req.user.avatarUrl, bio: req.user.bio || "",
        isPrivate: req.user.isPrivate || false, followersCount: req.user.followers?.length || 0,
        followingCount: req.user.following?.length || 0, mesPosts
    });
});

app.post('/users/me/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier fourni." });
    if (req.user.avatarUrl) await supprimerFichierPhysique(req.user.avatarUrl);
    req.user.avatarUrl = `/uploads/${req.file.filename}`;
    await saveDB();
    res.json({ message: "Photo mise à jour", avatarUrl: req.user.avatarUrl });
});

app.get('/users/search', authMiddleware, (req, res) => {
    const query = req.query.q || '';
    if (!query.trim()) return res.json([]);
    const results = db.users
        .filter(u => u._id !== req.user._id && u.pseudo.toLowerCase().includes(query.trim().toLowerCase()))
        .map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl, bio: u.bio }))
        .slice(0, 20);
    res.json(results);
});

app.put('/users/me/pseudo', authMiddleware, async (req, res) => {
    const nouveauPseudo = req.body.nouveauPseudo || req.body.pseudo;
    if (!nouveauPseudo || nouveauPseudo.trim().length < 3) {
        return res.status(400).json({ erreur: "Le pseudo doit contenir au moins 3 caractères." });
    }
    const clean = nouveauPseudo.trim();
    if (db.users.some(u => u._id !== req.user._id && u.pseudo.toLowerCase() === clean.toLowerCase())) {
        return res.status(409).json({ erreur: "Pseudonyme déjà utilisé." });
    }
    const index = db.users.findIndex(u => u._id === req.user._id);
    if (index !== -1) {
        db.users[index].pseudo = clean;
        await saveDB();
        res.json({ message: "Pseudonyme mis à jour.", user: db.users[index] });
    } else {
        res.status(404).json({ erreur: "Utilisateur introuvable." });
    }
});

app.delete('/users/me', authMiddleware, async (req, res) => {
    const userId = req.user._id;
    const index = db.users.findIndex(u => u._id === userId);
    if (index === -1) return res.status(404).json({ erreur: "Utilisateur introuvable." });

    db.posts = db.posts.filter(p => p.auteurId !== userId);
    db.statuses = db.statuses.filter(s => s.userId !== userId);
    db.users.splice(index, 1);
    await saveDB();
    res.json({ message: "Compte supprimé avec succès." });
});

app.post('/users/:id/follow', authMiddleware, async (req, res) => {
    if (req.params.id === req.user._id) return res.status(400).json({ erreur: "Action impossible." });
    const target = db.users.find(u => u._id === req.params.id);
    if (!target) return res.status(404).json({ erreur: "Introuvable." });
    
    if (req.user.blockedUsers.includes(target._id) || target.blockedUsers?.includes(req.user._id)) {
        return res.status(403).json({ erreur: "Bloqué." });
    }

    if (!req.user.following.includes(target._id)) {
        req.user.following.push(target._id);
        target.followers.push(req.user._id);
        await saveDB();
        await declarerNotification(target._id, req.user, 'follow');
    }
    res.json({ status: "following" });
});

// ============================================================================
// 6. ROUTES FEED, POSTS & BOOKMARKS
// ============================================================================

app.get('/feed', authMiddleware, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const autorises = [...(req.user.following || []), req.user._id];
    const postsAafficher = db.posts
        .filter(p => autorises.includes(p.auteurId) && !req.user.blockedUsers.includes(p.auteurId))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    const paginatedPosts = postsAafficher.slice(skip, skip + limit).map(post => {
        const auteur = db.users.find(u => u._id === post.auteurId);
        return {
            ...post,
            auteur: auteur ? { pseudo: auteur.pseudo, avatarUrl: auteur.avatarUrl } : { pseudo: "Anonyme" },
            estLeMien: post.auteurId === req.user._id
        };
    });

    res.json({ posts: paginatedPosts, currentPage: page, totalPages: Math.ceil(postsAafficher.length / limit) });
});

app.post('/posts', authMiddleware, upload.single('image'), async (req, res) => {
    const contenu = req.body.contenu || "";
    if (!contenu && !req.file) return res.status(400).json({ erreur: "Vide." });

    const newPost = {
        _id: crypto.randomUUID(), auteurId: req.user._id, contenu,
        imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
        mediaType: req.file?.mimetype.startsWith('video') ? 'video' : 'image',
        likes: [], commentaires: [], date: new Date().toISOString()
    };
    db.posts.push(newPost);
    await saveDB();
    res.status(201).json(newPost);
});

app.post('/posts/:id/like', authMiddleware, async (req, res) => {
    const post = db.posts.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Introuvable." });
    
    const index = post.likes.indexOf(req.user._id);
    if (index === -1) { post.likes.push(req.user._id); } else { post.likes.splice(index, 1); }
    await saveDB();
    res.json({ likesCount: post.likes.length });
});

app.post('/posts/:id/comment', authMiddleware, async (req, res) => {
    const post = db.posts.find(p => p._id === req.params.id);
    if (!post || !req.body.texte?.trim()) return res.status(400).json({ erreur: "Erreur." });

    const comment = { _id: crypto.randomUUID(), auteurId: req.user._id, auteurPseudo: req.user.pseudo, texte: req.body.texte.trim(), date: new Date().toISOString() };
    post.commentaires.push(comment);
    await saveDB();
    res.status(201).json(comment);
});

app.delete('/posts/:id', authMiddleware, async (req, res) => {
    const index = db.posts.findIndex(p => p._id === req.params.id);
    if (index !== -1 && db.posts[index].auteurId === req.user._id) {
        if (db.posts[index].imageUrl) await supprimerFichierPhysique(db.posts[index].imageUrl);
        db.posts.splice(index, 1);
        await saveDB();
    }
    res.json({ message: "Supprimé." });
});

// ============================================================================
// 7. ROUTES STORIES (STATUTS DE 24 HEURES)
// ============================================================================

app.get('/statuses', authMiddleware, (req, res) => {
    const maintenant = new Date();
    const validStatuses = db.statuses
        .filter(s => (maintenant - new Date(s.date)) < 86400000 && (s.userId === req.user._id || req.user.following.includes(s.userId)))
        .map(s => {
            const auteur = db.users.find(u => u._id === s.userId);
            return { ...s, author: auteur?.pseudo, avatarUrl: auteur?.avatarUrl, read: s.viewers?.some(v => v.userId === req.user._id) };
        });
    res.json(validStatuses);
});

app.post('/statuses', authMiddleware, upload.single('statusMedia'), async (req, res) => {
    if (!req.body.texte && !req.file) return res.status(400).json({ erreur: "Vide." });
    const newStatus = {
        _id: crypto.randomUUID(), userId: req.user._id, author: req.user.pseudo,
        text: req.body.texte || "", mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
        type: req.file ? (req.file.mimetype.startsWith('video') ? 'video' : 'image') : 'text',
        viewers: [], date: new Date().toISOString()
    };
    db.statuses.unshift(newStatus);
    await saveDB();
    res.status(201).json(newStatus);
});

app.post('/statuses/:id/view', authMiddleware, async (req, res) => {
    const status = db.statuses.find(s => s._id === req.params.id);
    if (status && status.userId !== req.user._id && !status.viewers.some(v => v.userId === req.user._id)) {
        status.viewers.push({ userId: req.user._id, viewedAt: new Date().toISOString() });
        await saveDB();
    }
    res.json({ success: true });
});

// ============================================================================
// 8. MESSAGERIE AVANCÉE (GROUPES, NOTES VOCALES, VU PAR...)
// ============================================================================

app.post('/conversations', authMiddleware, async (req, res) => {
    const { participantIds, isGroup, groupName } = req.body;
    const allParticipants = Array.from(new Set([...participantIds, req.user._id]));

    if (!isGroup && allParticipants.length === 2) {
        const existingConv = db.conversations.find(c => !c.isGroup && c.participants.length === 2 && c.participants.every(id => allParticipants.includes(id)));
        if (existingConv) return res.json(existingConv);
    }

    const newConv = {
        _id: crypto.randomUUID(), isGroup: !!isGroup, name: isGroup ? (groupName || "Groupe") : null,
        adminId: isGroup ? req.user._id : null, participants: allParticipants,
        lastMessage: null, updatedAt: new Date().toISOString()
    };
    db.conversations.push(newConv);
    await saveDB();
    allParticipants.forEach(userId => io.to(userId).emit('newConversation', newConv));
    res.status(201).json(newConv);
});

app.get('/conversations', authMiddleware, (req, res) => {
    const mesConvs = db.conversations
        .filter(c => c.participants.includes(req.user._id))
        .map(conv => {
            const profils = db.users.filter(u => conv.participants.includes(u._id) && u._id !== req.user._id).map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl }));
            const unreadCount = db.messages.filter(m => m.conversationId === conv._id && m.fromId !== req.user._id && (!m.readBy || !m.readBy.some(r => r.userId === req.user._id))).length;
            return { ...conv, displayProfiles: profils, unreadCount };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(mesConvs);
});

app.get('/conversations/:id/messages', authMiddleware, (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) return res.status(403).json({ erreur: "Refusé." });
    const msgs = db.messages.filter(m => m.conversationId === conv._id).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-50);
    res.json(msgs);
});

app.post('/conversations/:id/messages', authMiddleware, upload.single('media'), async (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) return res.status(403).json({ erreur: "Refusé." });

    let mediaType = 'text';
    if (req.file) mediaType = req.file.mimetype.startsWith('audio') ? 'audio' : (req.file.mimetype.startsWith('video') ? 'video' : 'image');

    const newMsg = {
        _id: crypto.randomUUID(), conversationId: conv._id, fromId: req.user._id, fromPseudo: req.user.pseudo,
        texte: req.body.texte || "", mediaUrl: req.file ? `/uploads/${req.file.filename}` : null, mediaType,
        status: 'sent', readBy: [{ userId: req.user._id, readAt: new Date().toISOString() }], date: new Date().toISOString()
    };

    db.messages.push(newMsg);
    conv.lastMessage = { texte: mediaType === 'audio' ? "🎤 Note vocale" : (newMsg.texte || "📷 Média"), fromId: req.user._id, date: newMsg.date };
    conv.updatedAt = newMsg.date;
    await saveDB();

    conv.participants.forEach(userId => {
        io.to(`conv_${conv._id}`).emit('newMessage', newMsg);
    });
    res.status(201).json(newMsg);
});

app.post('/conversations/:id/read', authMiddleware, async (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv) return res.status(404).json({ erreur: "Introuvable" });

    let updated = false;
    db.messages.filter(m => m.conversationId === conv._id && (!m.readBy || !m.readBy.some(r => r.userId === req.user._id))).forEach(m => {
        if (!m.readBy) m.readBy = [];
        m.readBy.push({ userId: req.user._id, readAt: new Date().toISOString() });
        m.status = 'read';
        updated = true;
    });

    if (updated) {
        await saveDB();
        io.to(`conv_${conv._id}`).emit('messagesRead', { conversationId: conv._id });
    }
    res.json({ success: true });
});

app.delete('/messages/:id', authMiddleware, async (req, res) => {
    const index = db.messages.findIndex(m => m._id === req.params.id);
    if (index !== -1 && db.messages[index].fromId === req.user._id) {
        if (db.messages[index].mediaUrl) await supprimerFichierPhysique(db.messages[index].mediaUrl);
        db.messages.splice(index, 1);
        await saveDB();
    }
    res.json({ message: "Supprimé." });
});

// ============================================================================
// 9. MOTEUR WEBSOCKETS
// ============================================================================

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Token manquant"));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.users.find(u => u._id === decoded.id);
        if (!user) return next(new Error("Inconnu"));
        socket.user = user;
        next();
    } catch (err) { next(new Error("Invalide")); }
});

io.on('connection', (socket) => {
    socket.join(socket.user._id);
    db.conversations.filter(c => c.participants.includes(socket.user._id)).forEach(c => socket.join(`conv_${c._id}`));

    socket.on('typing', ({ conversationId, isAudio }) => {
        socket.to(`conv_${conversationId}`).emit('userTyping', { pseudo: socket.user.pseudo, conversationId, action: isAudio ? "enregistre un audio..." : "écrit..." });
    });

    socket.on('stopTyping', (conversationId) => {
        socket.to(`conv_${conversationId}`).emit('userStoppedTyping', { conversationId });
    });
    
    socket.on('deleteMessage', ({ messageId, conversationId }) => {
        socket.to(`conv_${conversationId}`).emit('messageDeleted', { messageId, conversationId });
    });

    socket.on('toggleEphemere', ({ conversationId, actif }) => {
        socket.to(`conv_${conversationId}`).emit('ephemereToggled', { conversationId, actif });
    });
});

// ============================================================================
// 10. NETTOYAGE CRON AUTOMATIQUE
// ============================================================================

setInterval(async () => {
    const limite24h = Date.now() - (24 * 60 * 60 * 1000);
    const expirees = db.statuses.filter(s => new Date(s.date).getTime() < limite24h);
    if (expirees.length > 0) {
        for (const s of expirees) if (s.mediaUrl) await supprimerFichierPhysique(s.mediaUrl);
        db.statuses = db.statuses.filter(s => new Date(s.date).getTime() >= limite24h);
        await saveDB();
    }
}, 3600000);

server.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne sur le port : ${PORT}`);
});