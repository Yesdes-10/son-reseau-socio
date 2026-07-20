/**
 * JO SOCIO - ENTERPRISE BACKEND ENGINE
 * Serveur d'application temps réel avec persistance de données JSON
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST", "PUT", "DELETE"] 
    }
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

// --- INITIALISATION DU SYSTEME DE STOCKAGE ---
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let db = { users: [], posts: [], messages: [], notifications: [], statuses: [] };
if (fs.existsSync(DATA_FILE)) {
    try {
        const fileContent = fs.readFileSync(DATA_FILE, 'utf8');
        db = JSON.parse(fileContent || '{"users":[],"posts":[],"messages":[],"notifications":[],"statuses":[]}');
    } catch (err) {
        console.error("⚠️ Erreur de lecture de la base de données. Réinitialisation sécurisée.", err);
    }
}

const saveDB = () => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (err) {
        console.error("❌ Erreur lors de l'écriture dans data.json :", err);
    }
};

// --- SECURITE & CRYPTOGRAPHIE ---
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

// --- MIDDLEWARES ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Configuration Multer & Sécurisation des extensions
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        cb(null, `${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // Limite globale de 50 Mo
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|webm|mpeg|ogg|mp3|wav/;
        const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimeType = allowedTypes.test(file.mimetype);
        if (extName && mimeType) return cb(null, true);
        cb(new Error("Format de fichier non supporté."));
    }
});

// Nettoyage physique des fichiers (Garbage Collection)
const supprimerFichierPhysique = (fileUrl) => {
    if (!fileUrl) return;
    const fileName = path.basename(fileUrl);
    const filePath = path.join(UPLOADS_DIR, fileName);
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) console.error(`[Fichier] Impossible de supprimer : ${filePath}`, err);
        });
    }
};

// Injection automatique et envoi temps réel de notifications
const declarerNotification = (toId, fromUser, type, targetId = null) => {
    if (toId === fromUser._id) return; // Pas de notification à soi-même
    
    const newNotif = {
        _id: crypto.randomUUID(),
        toId,
        fromId: fromUser._id,
        fromPseudo: fromUser.pseudo,
        type, // 'like' | 'comment' | 'follow'
        targetId,
        read: false,
        date: new Date().toISOString()
    };
    db.notifications.push(newNotif);
    saveDB();

    // Notification Push en temps réel via WebSocket
    io.to(toId).emit('newNotification', newNotif);
};

// Middleware d'authentification par Token
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ erreur: "Accès refusé. Token manquant." });
    }
    const token = authHeader.split(' ')[1];
    const user = db.users.find(u => u.token === token);
    if (!user) return res.status(403).json({ erreur: "Session expirée ou invalide." });
    req.user = user;
    next();
};

// --- ROUTES : AUTHENTIFICATION ---
app.post('/auth/inscription', (req, res) => {
    const { pseudo, password } = req.body;
    if (!pseudo || !password || !pseudo.trim()) {
        return res.status(400).json({ erreur: "Tous les champs sont requis." });
    }
    const cleanPseudo = pseudo.trim();
    if (db.users.some(u => u.pseudo.toLowerCase() === cleanPseudo.toLowerCase())) {
        return res.status(400).json({ erreur: "Ce nom d'utilisateur est déjà pris." });
    }

    const newUser = {
        _id: crypto.randomUUID(),
        pseudo: cleanPseudo,
        password: hashPassword(password),
        token: crypto.randomBytes(32).toString('hex'),
        avatarUrl: null,
        following: [],
        followers: []
    };
    
    db.users.push(newUser);
    saveDB();
    res.status(201).json({ message: "Compte créé avec succès." });
});

app.post('/auth/connexion', (req, res) => {
    const { pseudo, password } = req.body;
    if (!pseudo || !password) return res.status(400).json({ erreur: "Champs manquants." });

    const user = db.users.find(u => 
        u.pseudo.toLowerCase() === pseudo.trim().toLowerCase() && 
        u.password === hashPassword(password)
    );
    
    if (!user) return res.status(401).json({ erreur: "Identifiants incorrects." });
    res.json({ token: user.token, _id: user._id, pseudo: user.pseudo });
});

// --- ROUTES : UTILISATEURS ---
app.get('/users/me', authMiddleware, (req, res) => {
    const mesPosts = db.posts.filter(p => p.auteurId === req.user._id);
    res.json({
        _id: req.user._id,
        pseudo: req.user.pseudo,
        avatarUrl: req.user.avatarUrl,
        abonnementsCount: req.user.following ? req.user.following.length : 0,
        mesPosts
    });
});

app.post('/users/me/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier reçu." });
    if (req.user.avatarUrl) supprimerFichierPhysique(req.user.avatarUrl);
    
    req.user.avatarUrl = `/uploads/${req.file.filename}`;
    saveDB();
    res.json({ avatarUrl: req.user.avatarUrl });
});

app.put('/users/me/pseudo', authMiddleware, (req, res) => {
    const { nouveauPseudo } = req.body;
    if (!nouveauPseudo || !nouveauPseudo.trim()) {
        return res.status(400).json({ erreur: "Le pseudo ne peut pas être vide." });
    }
    
    const cleanPseudo = nouveauPseudo.trim();
    if (db.users.some(u => u._id !== req.user._id && u.pseudo.toLowerCase() === cleanPseudo.toLowerCase())) {
        return res.status(400).json({ erreur: "Ce pseudo est déjà utilisé." });
    }

    req.user.pseudo = cleanPseudo;
    saveDB();
    res.json({ message: "Votre profil a été mis à jour avec succès." });
});

app.delete('/users/me', authMiddleware, (req, res) => {
    if (req.user.avatarUrl) supprimerFichierPhysique(req.user.avatarUrl);
    
    // Purge complète de ses publications et fichiers liés
    db.posts.filter(p => p.auteurId === req.user._id).forEach(p => supprimerFichierPhysique(p.imageUrl));
    db.posts = db.posts.filter(p => p.auteurId !== req.user._id);
    
    // Purge des messages
    db.messages.filter(m => m.fromId === req.user._id || m.toId === req.user._id).forEach(m => supprimerFichierPhysique(m.mediaUrl));
    db.messages = db.messages.filter(m => m.fromId !== req.user._id && m.toId !== req.user._id);

    db.users = db.users.filter(u => u._id !== req.user._id);
    saveDB();
    res.json({ message: "Votre compte a été définitivement supprimé." });
});

app.get('/users/search', authMiddleware, (req, res) => {
    const query = req.query.q?.toLowerCase() || "";
    const results = db.users
        .filter(u => u._id !== req.user._id && u.pseudo.toLowerCase().includes(query))
        .map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl }));
    res.json(results);
});

app.get('/users/:id', authMiddleware, (req, res) => {
    if (req.params.id === req.user._id || req.params.id === 'me') {
        return res.json({ redirectMe: true });
    }
    const targetUser = db.users.find(u => u._id === req.params.id);
    if (!targetUser) return res.status(404).json({ erreur: "Utilisateur introuvable." });
    
    const posts = db.posts.filter(p => p.auteurId === targetUser._id);
    res.json({
        _id: targetUser._id,
        pseudo: targetUser.pseudo,
        avatarUrl: targetUser.avatarUrl,
        postsCount: posts.length,
        estAbonne: req.user.following ? req.user.following.includes(targetUser._id) : false,
        posts
    });
});

app.post('/users/:id/follow', authMiddleware, (req, res) => {
    if (req.params.id === req.user._id) return res.status(400).json({ erreur: "Action impossible." });
    if (!req.user.following) req.user.following = [];
    
    const targetUser = db.users.find(u => u._id === req.params.id);
    if (!targetUser) return res.status(404).json({ erreur: "Utilisateur introuvable." });

    if (!req.user.following.includes(req.params.id)) {
        req.user.following.push(req.params.id);
        saveDB();
        declarerNotification(req.params.id, req.user, 'follow');
    }
    res.json({ success: true });
});

app.post('/users/:id/unfollow', authMiddleware, (req, res) => {
    if (!req.user.following) req.user.following = [];
    req.user.following = req.user.following.filter(id => id !== req.params.id);
    saveDB();
    res.json({ success: true });
});

// --- ROUTES : FIL D'ACTUALITES & POSTS ---
app.get('/feed', authMiddleware, (req, res) => {
    const feedPosts = db.posts
        .map(post => {
            const auteur = db.users.find(u => u._id === post.auteurId);
            return {
                ...post,
                auteur: auteur ? { pseudo: auteur.pseudo, avatarUrl: auteur.avatarUrl } : { pseudo: "Anonyme" },
                estLeMien: post.auteurId === req.user._id
            };
        })
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(feedPosts);
});

app.post('/posts', authMiddleware, upload.single('image'), (req, res) => {
    if (!req.body.contenu && !req.file) {
        return res.status(400).json({ erreur: "Votre publication est vide." });
    }

    const newPost = {
        _id: crypto.randomUUID(),
        auteurId: req.user._id,
        contenu: req.body.contenu || "",
        imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
        mediaType: req.file?.mimetype.startsWith('video') ? 'video' : 'image',
        likes: [],
        commentaires: [],
        date: new Date().toISOString()
    };
    db.posts.push(newPost);
    saveDB();
    res.status(201).json(newPost);
});

app.post('/posts/:id/like', authMiddleware, (req, res) => {
    const post = db.posts.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Publication introuvable." });
    
    const index = post.likes.indexOf(req.user._id);
    let aAime = false;
    if (index === -1) {
        post.likes.push(req.user._id);
        aAime = true;
    } else {
        post.likes.splice(index, 1);
    }
    saveDB();

    if (aAime) {
        declarerNotification(post.auteurId, req.user, 'like', post._id);
    }
    res.json({ likesCount: post.likes.length });
});

app.post('/posts/:id/comment', authMiddleware, (req, res) => {
    const post = db.posts.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Publication introuvable." });
    if (!req.body.texte || !req.body.texte.trim()) {
        return res.status(400).json({ erreur: "Le commentaire ne peut pas être vide." });
    }

    const comment = {
        _id: crypto.randomUUID(),
        auteur: req.user.pseudo,
        texte: req.body.texte.trim(),
        date: new Date().toISOString()
    };
    post.commentaires.push(comment);
    saveDB();

    declarerNotification(post.auteurId, req.user, 'comment', post._id);
    res.status(201).json(comment);
});

app.delete('/posts/:id', authMiddleware, (req, res) => {
    const postIndex = db.posts.findIndex(p => p._id === req.params.id && p.auteurId === req.user._id);
    if (postIndex === -1) return res.status(403).json({ erreur: "Action non autorisée." });
    
    if (db.posts[postIndex].imageUrl) {
        supprimerFichierPhysique(db.posts[postIndex].imageUrl);
    }
    db.posts.splice(postIndex, 1);
    saveDB();
    res.json({ success: true });
});

// --- ROUTES : MESSAGERIE PURE ---
app.get('/messages/contacts', authMiddleware, (req, res) => {
    const contacts = db.users
        .filter(u => u._id !== req.user._id)
        .map(u => {
            const lastMsg = db.messages
                .filter(m => (m.fromId === req.user._id && m.toId === u._id) || (m.fromId === u._id && m.toId === req.user._id))
                .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
            return {
                _id: u._id,
                pseudo: u.pseudo,
                avatarUrl: u.avatarUrl,
                dernierMessage: lastMsg ? (lastMsg.mediaType === 'audio' ? "[Message vocal]" : lastMsg.texte) : null
            };
        });
    res.json(contacts);
});

app.get('/messages/:id', authMiddleware, (req, res) => {
    const msgs = db.messages.filter(m => 
        (m.fromId === req.user._id && m.toId === req.params.id) || 
        (m.fromId === req.params.id && m.toId === req.user._id)
    ).sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json(msgs);
});

app.post('/messages/:id', authMiddleware, upload.single('media'), (req, res) => {
    if (!req.body.texte && !req.file) {
        return res.status(400).json({ erreur: "Impossible d'envoyer un message vide." });
    }

    const newMsg = {
        _id: crypto.randomUUID(),
        fromId: req.user._id,
        toId: req.params.id,
        texte: req.body.texte || "",
        mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
        mediaType: req.file ? (req.file.mimetype.startsWith('audio') ? 'audio' : 'image') : 'text',
        status: 'sent',
        date: new Date().toISOString()
    };
    db.messages.push(newMsg);
    saveDB();
    
    // Notification sockets temps réel en direct
    io.to(req.params.id).emit('newMessage', newMsg);
    res.status(201).json(newMsg);
});

app.delete('/messages/clear/:id', authMiddleware, (req, res) => {
    db.messages.filter(m => 
        ((m.fromId === req.user._id && m.toId === req.params.id) || (m.fromId === req.params.id && m.toId === req.user._id))
    ).forEach(m => supprimerFichierPhysique(m.mediaUrl));

    db.messages = db.messages.filter(m => 
        !((m.fromId === req.user._id && m.toId === req.params.id) || (m.fromId === req.params.id && m.toId === req.user._id))
    );
    saveDB();
    res.json({ success: true });
});

app.delete('/messages/:id', authMiddleware, (req, res) => {
    const msgIndex = db.messages.findIndex(m => m._id === req.params.id && m.fromId === req.user._id);
    if (msgIndex !== -1) {
        supprimerFichierPhysique(db.messages[msgIndex].mediaUrl);
        db.messages.splice(msgIndex, 1);
        saveDB();
    }
    res.json({ success: true });
});

// --- ROUTES : MODULE DE STATUS & AUDIENCE ---
app.get('/statuses', authMiddleware, (req, res) => {
    // Règle métier : Rendre obsolète les statuts datant de plus de 24h
    db.statuses = db.statuses.filter(s => (new Date() - new Date(s.date)) < 86400000);
    saveDB();
    res.json(db.statuses);
});

app.post('/statuses', authMiddleware, upload.single('statusMedia'), (req, res) => {
    if (!req.body.texte && !req.file) {
        return res.status(400).json({ erreur: "Le contenu du statut ne peut pas être vide." });
    }

    const newStatus = {
        _id: crypto.randomUUID(),
        userId: req.user._id,
        author: req.user.pseudo,
        avatarUrl: req.user.avatarUrl,
        text: req.body.texte || "",
        mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
        type: req.file ? 'image' : 'text',
        date: new Date().toISOString()
    };
    db.statuses.push(newStatus);
    saveDB();
    res.status(201).json(newStatus);
});

app.post('/statuses/:id/read', authMiddleware, (req, res) => res.json({ success: true }));

// --- ROUTES : NOTIFICATIONS ---
app.get('/notifications', authMiddleware, (req, res) => {
    const mesNotifs = db.notifications
        .filter(n => n.toId === req.user._id)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(mesNotifs);
});

app.post('/notifications/read', authMiddleware, (req, res) => {
    db.notifications.filter(n => n.toId === req.user._id).forEach(n => n.read = true);
    saveDB();
    res.json({ success: true });
});

// --- ENGINE: REAL-TIME MANAGEMENT (WEBSOCKETS) ---
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = db.users.find(u => u.token === token);
    if (!user) return next(new Error("Erreur d'authentification WebSocket"));
    socket.user = user;
    next();
});

io.on('connection', (socket) => {
    // Le membre rejoint son canal d'écoute personnel exclusif
    socket.join(socket.user._id);
    
    // Diffusion globale de son statut en ligne
    io.emit('userStatusChange', { userId: socket.user._id, status: 'online' });

    socket.on('typing', (targetId) => {
        io.to(targetId).emit('userTyping', socket.user._id);
    });

    socket.on('stopTyping', (targetId) => {
        io.to(targetId).emit('userStoppedTyping', socket.user._id);
    });

    socket.on('markAsRead', (targetId) => {
        db.messages
            .filter(m => m.fromId === targetId && m.toId === socket.user._id)
            .forEach(m => m.status = 'read');
        saveDB();
        io.to(targetId).emit('messagesReadBy', socket.user._id);
    });

    socket.on('disconnect', () => {
        io.emit('userStatusChange', { userId: socket.user._id, status: 'offline' });
    });
});

// --- RUN SERVER ---
server.listen(PORT, () => console.log(`🚀 Production Core Engine actif : http://localhost:${PORT}`));