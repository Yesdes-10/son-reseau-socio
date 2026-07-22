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

// Création du dossier d'upload s'il n'existe pas
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

// Lecture asynchrone au démarrage
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
        console.error("⚠️ [Erreur DB] Lecture impossible, initialisation vide :", err);
    }
};
initDB();

// Sauvegarde asynchrone (Non-bloquante)
const saveDB = async () => {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (err) {
        console.error("❌ [Erreur DB] Écriture impossible :", err);
    }
};

// ============================================================================
// 3. MIDDLEWARES & STORAGE MULTER (IMAGES, VIDÉOS, AUDIOS)
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
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 Mo max
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|webm|mp3|wav|ogg/;
        const isExtValid = allowed.test(path.extname(file.originalname).toLowerCase());
        const isMimeValid = allowed.test(file.mimetype);
        if (isExtValid && isMimeValid) return cb(null, true);
        cb(new Error("Format de fichier non pris en charge."));
    }
});

// Middleware d'authentification JWT
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ erreur: "Token d'authentification manquant." });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.users.find(u => u._id === decoded.id);
        if (!user) return res.status(403).json({ erreur: "Compte introuvable ou supprimé." });
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ erreur: "Token invalide ou expiré." });
    }
};

// ============================================================================
// 4. OUTILS UTILITAIRES & NOTIFICATIONS
// ============================================================================

const extraireHashtags = (texte = "") => {
    const matches = texte.match(/#[a-zA-Z0-9_]+/g);
    return matches ? matches.map(tag => tag.toLowerCase()) : [];
};

const extraireMentions = (texte = "") => {
    const matches = texte.match(/@[a-zA-Z0-9_]+/g);
    return matches ? matches.map(mention => mention.substring(1).toLowerCase()) : [];
};

const supprimerFichierPhysique = async (fileUrl) => {
    if (!fileUrl) return;
    try {
        const filePath = path.join(UPLOADS_DIR, path.basename(fileUrl));
        if (fsSync.existsSync(filePath)) await fs.unlink(filePath);
    } catch (err) {
        console.error(`⚠️ Erreur suppression fichier (${fileUrl}):`, err);
    }
};

const declarerNotification = async (toId, fromUser, type, targetId = null, extraData = null) => {
    if (toId === fromUser._id) return;
    const newNotif = {
        _id: crypto.randomUUID(),
        toId,
        fromId: fromUser._id,
        fromPseudo: fromUser.pseudo,
        fromAvatar: fromUser.avatarUrl,
        type, // 'like', 'comment', 'follow', 'mention', 'follow_request'
        targetId,
        extraData,
        read: false,
        date: new Date().toISOString()
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
            _id: crypto.randomUUID(),
            pseudo: cleanPseudo,
            password: hashedPassword,
            avatarUrl: null,
            bio: "",
            isPrivate: false,
            following: [],
            followers: [],
            followRequests: [],
            blockedUsers: [],
            bookmarks: [],
            createdAt: new Date().toISOString()
        };
        
        db.users.push(newUser);
        await saveDB();

        const token = jwt.sign({ id: newUser._id }, JWT_SECRET, { expiresIn: '14d' });
        res.status(201).json({ token, _id: newUser._id, pseudo: newUser.pseudo });
    } catch (err) {
        res.status(500).json({ erreur: "Erreur serveur lors de l'inscription." });
    }
});

app.post('/auth/connexion', async (req, res) => {
    try {
        const { pseudo, password } = req.body;
        if (!pseudo || !password) return res.status(400).json({ erreur: "Identifiants manquants." });

        const user = db.users.find(u => u.pseudo.toLowerCase() === pseudo.trim().toLowerCase());
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ erreur: "Pseudo ou mot de passe incorrect." });
        }

        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '14d' });
        res.json({ token, _id: user._id, pseudo: user.pseudo, avatarUrl: user.avatarUrl });
    } catch (err) {
        res.status(500).json({ erreur: "Erreur lors de la connexion." });
    }
});

app.get('/users/me', authMiddleware, (req, res) => {
    const mesPosts = db.posts
        .filter(p => p.auteurId === req.user._id)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
        _id: req.user._id,
        pseudo: req.user.pseudo,
        avatarUrl: req.user.avatarUrl,
        bio: req.user.bio || "",
        isPrivate: req.user.isPrivate || false,
        followersCount: req.user.followers?.length || 0,
        followingCount: req.user.following?.length || 0,
        mesPosts
    });
});

app.post('/users/me/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier fourni." });
    if (req.user.avatarUrl) await supprimerFichierPhysique(req.user.avatarUrl);
    
    req.user.avatarUrl = `/uploads/${req.file.filename}`;
    await saveDB();
    res.json({ message: "Photo de profil mise à jour !", avatarUrl: req.user.avatarUrl });
});

app.post('/users/:id/follow', authMiddleware, async (req, res) => {
    if (req.params.id === req.user._id) return res.status(400).json({ erreur: "Action impossible." });
    const target = db.users.find(u => u._id === req.params.id);
    if (!target) return res.status(404).json({ erreur: "Utilisateur introuvable." });
    
    if (req.user.blockedUsers.includes(target._id) || target.blockedUsers?.includes(req.user._id)) {
        return res.status(403).json({ erreur: "Interaction bloquée." });
    }

    if (target.isPrivate) {
        if (!target.followRequests.includes(req.user._id)) {
            target.followRequests.push(req.user._id);
            await saveDB();
            await declarerNotification(target._id, req.user, 'follow_request');
        }
        return res.json({ status: "requested", message: "Demande d'abonnement envoyée." });
    } else {
        if (!req.user.following.includes(target._id)) {
            req.user.following.push(target._id);
            target.followers.push(req.user._id);
            await saveDB();
            await declarerNotification(target._id, req.user, 'follow');
        }
        return res.json({ status: "following", message: `Vous suivez désormais @${target.pseudo}.` });
    }
});

app.post('/users/:id/block', authMiddleware, async (req, res) => {
    const targetId = req.params.id;
    if (!req.user.blockedUsers) req.user.blockedUsers = [];
    if (!req.user.blockedUsers.includes(targetId)) {
        req.user.blockedUsers.push(targetId);
        req.user.following = req.user.following.filter(id => id !== targetId);
        req.user.followers = req.user.followers.filter(id => id !== targetId);
        await saveDB();
    }
    res.json({ message: "Utilisateur bloqué avec succès." });
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
            likesCount: post.likes?.length || 0,
            commentsCount: post.commentaires?.length || 0,
            estLeMien: post.auteurId === req.user._id,
            aAime: post.likes?.includes(req.user._id) || false
        };
    });

    res.json({
        posts: paginatedPosts,
        currentPage: page,
        totalPages: Math.ceil(postsAafficher.length / limit),
        hasMore: skip + limit < postsAafficher.length
    });
});

app.post('/posts', authMiddleware, upload.single('image'), async (req, res) => {
    const contenu = req.body.contenu || "";
    if (!contenu && !req.file) return res.status(400).json({ erreur: "La publication ne peut pas être vide." });

    const newPost = {
        _id: crypto.randomUUID(),
        auteurId: req.user._id,
        contenu,
        imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
        mediaType: req.file?.mimetype.startsWith('video') ? 'video' : 'image',
        hashtags: extraireHashtags(contenu),
        mentions: extraireMentions(contenu),
        likes: [],
        commentaires: [],
        savedBy: [],
        date: new Date().toISOString()
    };
    db.posts.push(newPost);
    await saveDB();

    newPost.mentions.forEach(async (pseudo) => {
        const u = db.users.find(usr => usr.pseudo.toLowerCase() === pseudo);
        if (u) await declarerNotification(u._id, req.user, 'mention', newPost._id);
    });

    res.status(201).json(newPost);
});

app.post('/posts/:id/like', authMiddleware, async (req, res) => {
    const post = db.posts.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Post introuvable." });
    
    if (!post.likes) post.likes = [];
    const index = post.likes.indexOf(req.user._id);
    let aAime = false;
    
    if (index === -1) {
        post.likes.push(req.user._id);
        aAime = true;
        await declarerNotification(post.auteurId, req.user, 'like', post._id);
    } else {
        post.likes.splice(index, 1);
    }
    await saveDB();
    res.json({ likesCount: post.likes.length, aAime });
});

app.post('/posts/:id/comment', authMiddleware, async (req, res) => {
    const post = db.posts.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Post introuvable." });
    if (!req.body.texte?.trim()) return res.status(400).json({ erreur: "Le commentaire est vide." });

    if (!post.commentaires) post.commentaires = [];
    const comment = {
        _id: crypto.randomUUID(),
        auteurId: req.user._id,
        auteurPseudo: req.user.pseudo,
        auteurAvatar: req.user.avatarUrl,
        texte: req.body.texte.trim(),
        parentId: req.body.parentId || null,
        date: new Date().toISOString()
    };
    
    post.commentaires.push(comment);
    await saveDB();
    await declarerNotification(post.auteurId, req.user, 'comment', post._id, { commentText: comment.texte });
    res.status(201).json(comment);
});

app.delete('/posts/:id', authMiddleware, async (req, res) => {
    const index = db.posts.findIndex(p => p._id === req.params.id);
    if (index === -1) return res.status(404).json({ erreur: "Post introuvable." });
    if (db.posts[index].auteurId !== req.user._id) return res.status(403).json({ erreur: "Non autorisé." });
    
    if (db.posts[index].imageUrl) await supprimerFichierPhysique(db.posts[index].imageUrl);
    db.posts.splice(index, 1);
    await saveDB();
    res.json({ message: "Post supprimé avec succès." });
});

// ============================================================================
// 7. ROUTES STORIES (STATUTS DE 24 HEURES)
// ============================================================================

app.get('/statuses', authMiddleware, (req, res) => {
    const maintenant = new Date();
    const limite24h = 86400000;
    
    const validStatuses = db.statuses
        .filter(s => {
            const estRecent = (maintenant - new Date(s.date)) < limite24h;
            const nonBloque = !req.user.blockedUsers.includes(s.userId);
            const estAmi = s.userId === req.user._id || req.user.following.includes(s.userId);
            return estRecent && nonBloque && estAmi;
        })
        .map(s => {
            const auteur = db.users.find(u => u._id === s.userId);
            return {
                ...s,
                author: auteur ? auteur.pseudo : s.author,
                avatarUrl: auteur ? auteur.avatarUrl : s.avatarUrl,
                read: s.viewers ? s.viewers.some(v => v.userId === req.user._id) : false
            };
        });
    res.json(validStatuses);
});

app.post('/statuses', authMiddleware, upload.single('statusMedia'), async (req, res) => {
    if (!req.body.texte && !req.file) return res.status(400).json({ erreur: "Statut vide impossible." });
    const newStatus = {
        _id: crypto.randomUUID(),
        userId: req.user._id,
        author: req.user.pseudo,
        avatarUrl: req.user.avatarUrl,
        text: req.body.texte || "",
        mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
        type: req.file ? (req.file.mimetype.startsWith('video') ? 'video' : 'image') : 'text',
        viewers: [],
        date: new Date().toISOString()
    };
    db.statuses.unshift(newStatus);
    await saveDB();
    res.status(201).json(newStatus);
});

app.post('/statuses/:id/view', authMiddleware, async (req, res) => {
    const status = db.statuses.find(s => s._id === req.params.id);
    if (!status) return res.status(404).json({ erreur: "Story introuvable." });
    
    if (!status.viewers) status.viewers = [];
    if (status.userId !== req.user._id && !status.viewers.some(v => v.userId === req.user._id)) {
        status.viewers.push({
            userId: req.user._id,
            pseudo: req.user.pseudo,
            avatarUrl: req.user.avatarUrl,
            viewedAt: new Date().toISOString()
        });
        await saveDB();
    }
    res.json({ viewersCount: status.viewers.length });
});

// ============================================================================
// 8. MESSAGERIE AVANCÉE (GROUPES, NOTES VOCALES, VU PAR...)
// ============================================================================

app.post('/conversations', authMiddleware, async (req, res) => {
    const { participantIds, isGroup, groupName } = req.body;
    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
        return res.status(400).json({ erreur: "Participants requis." });
    }

    const allParticipants = Array.from(new Set([...participantIds, req.user._id]));

    if (!isGroup && allParticipants.length === 2) {
        const existingConv = db.conversations.find(c => 
            !c.isGroup && c.participants.length === 2 && c.participants.every(id => allParticipants.includes(id))
        );
        if (existingConv) return res.json(existingConv);
    }

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

    allParticipants.forEach(userId => io.to(userId).emit('newConversation', newConv));
    res.status(201).json(newConv);
});

app.get('/conversations', authMiddleware, (req, res) => {
    const mesConvs = db.conversations
        .filter(c => c.participants.includes(req.user._id))
        .map(conv => {
            const profils = db.users
                .filter(u => conv.participants.includes(u._id) && u._id !== req.user._id)
                .map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl }));
            
            const unreadCount = db.messages.filter(m => 
                m.conversationId === conv._id && m.fromId !== req.user._id && (!m.readBy || !m.readBy.some(r => r.userId === req.user._id))
            ).length;

            return { ...conv, displayProfiles: profils, unreadCount };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json(mesConvs);
});

app.get('/conversations/:id/messages', authMiddleware, (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) {
        return res.status(403).json({ erreur: "Accès refusé." });
    }
    const limit = parseInt(req.query.limit) || 50;
    const msgs = db.messages
        .filter(m => m.conversationId === conv._id)
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(-limit);

    res.json(msgs);
});

app.post('/conversations/:id/messages', authMiddleware, upload.single('media'), async (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) return res.status(403).json({ erreur: "Accès refusé." });
    if (!req.body.texte && !req.file) return res.status(400).json({ erreur: "Message vide." });

    let mediaType = 'text';
    if (req.file) {
        if (req.file.mimetype.startsWith('audio')) mediaType = 'audio';
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
        duration: req.body.duration ? parseInt(req.body.duration) : null,
        reactions: [],
        status: 'sent',
        readBy: [{ userId: req.user._id, readAt: new Date().toISOString() }],
        date: new Date().toISOString()
    };

    db.messages.push(newMsg);
    conv.lastMessage = {
        texte: mediaType === 'audio' ? "🎤 Note vocale" : (newMsg.texte || "📷 Média"),
        fromId: req.user._id,
        date: newMsg.date
    };
    conv.updatedAt = newMsg.date;
    await saveDB();

    conv.participants.forEach(userId => {
        io.to(userId).emit('newMessage', newMsg);
        io.to(userId).emit('conversationUpdated', conv);
    });

    res.status(201).json(newMsg);
});

app.post('/conversations/:id/read', authMiddleware, async (req, res) => {
    const conv = db.conversations.find(c => c._id === req.params.id);
    if (!conv || !conv.participants.includes(req.user._id)) return res.status(403).json({ erreur: "Refusé." });

    const maintenant = new Date().toISOString();
    let updated = false;

    db.messages
        .filter(m => m.conversationId === conv._id && (!m.readBy || !m.readBy.some(r => r.userId === req.user._id)))
        .forEach(m => {
            if (!m.readBy) m.readBy = [];
            m.readBy.push({ userId: req.user._id, readAt: maintenant });
            if (!conv.isGroup) m.status = 'read';
            updated = true;
        });

    if (updated) {
        await saveDB();
        conv.participants.forEach(userId => {
            if (userId !== req.user._id) {
                io.to(userId).emit('messagesRead', {
                    conversationId: conv._id,
                    readByUserId: req.user._id,
                    readAt: maintenant
                });
            }
        });
    }
    res.json({ success: true, readAt: maintenant });
});

app.delete('/messages/:id', authMiddleware, async (req, res) => {
    const index = db.messages.findIndex(m => m._id === req.params.id);
    if (index === -1) return res.status(404).json({ erreur: "Message introuvable." });
    
    const msg = db.messages[index];
    if (msg.fromId !== req.user._id) return res.status(403).json({ erreur: "Interdit." });

    if (msg.mediaUrl) await supprimerFichierPhysique(msg.mediaUrl);
    db.messages.splice(index, 1);
    await saveDB();
    res.json({ message: "Message supprimé." });
});

// ============================================================================
// 9. MOTEUR WEBSOCKETS (TEMPS RÉEL AVANCÉ)
// ============================================================================

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Token WebSocket manquant"));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.users.find(u => u._id === decoded.id);
        if (!user) return next(new Error("Utilisateur introuvable"));
        socket.user = user;
        next();
    } catch (err) {
        next(new Error("Token invalide"));
    }
});

io.on('connection', (socket) => {
    // Room personnelle (pour recevoir notifications et DM)
    socket.join(socket.user._id);
    
    // Rejoindre automatiquement les rooms de ses conversations
    db.conversations
        .filter(c => c.participants.includes(socket.user._id))
        .forEach(c => socket.join(`conv_${c._id}`));

    io.emit('userStatusChange', { userId: socket.user._id, status: 'online' });

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

// ============================================================================
// 10. NETTOYAGE CRON AUTOMATIQUE (STORIES EXPIRÉES)
// ============================================================================

setInterval(async () => {
    const limite24h = Date.now() - (24 * 60 * 60 * 1000);
    const expirees = db.statuses.filter(s => new Date(s.date).getTime() < limite24h);
    
    if (expirees.length > 0) {
        for (const status of expirees) {
            if (status.mediaUrl) await supprimerFichierPhysique(status.mediaUrl);
        }
        db.statuses = db.statuses.filter(s => new Date(s.date).getTime() >= limite24h);
        await saveDB();
        console.log(`⏱️ [Nettoyage automatique] ${expirees.length} stories expirées ont été supprimées.`);
    }
}, 60 * 60 * 1000); // Toutes les heures

// ============================================================================
// DÉMARRAGE DU SERVEUR
// ============================================================================

server.listen(PORT, () => {
    console.log(`🟢 ========================================================`);
    console.log(`🚀 Serveur JO SOCIO en ligne sur le port : ${PORT}`);
    console.log(`📦 Système prêt pour le trafic Web, Android et iOS`);
    console.log(`🟢 ========================================================`);
});