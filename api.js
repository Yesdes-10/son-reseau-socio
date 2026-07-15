const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

// --- INITIALISATION HTTP & WEBSOCKETS ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST", "DELETE", "PUT"] }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'frontend')));

const SECRET_KEY = "ma_cle_secrete_reseau_social";
const fileUsers = path.join(__dirname, 'utilisateurs.json');
const filePosts = path.join(__dirname, 'publications.json');
const fileMessages = path.join(__dirname, 'messages.json');
const fileStatuses = path.join(__dirname, 'statuts.json');

// --- CONFIGURATION MULTER (STORAGE) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- UTILITAIRES BASE DE DONNÉES JSON ---
function lireDB(fichier) {
    if (!fs.existsSync(fichier)) { fs.writeFileSync(fichier, JSON.stringify([])); return []; }
    try { return JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch(e) { return []; }
}
function ecrireDB(fichier, donnees) { fs.writeFileSync(fichier, JSON.stringify(donnees, null, 2)); }

function ajouterNotification(userId, type, fromPseudo, postId) {
    const utilisateurs = lireDB(fileUsers);
    const user = utilisateurs.find(u => u._id === userId);
    if (user) {
        if (!user.notifications) user.notifications = [];
        user.notifications.unshift({
            id: Date.now().toString(), type, fromPseudo, postId, read: false, date: new Date()
        });
        ecrireDB(fileUsers, utilisateurs);
    }
}

// --- MIDDLEWARE DE SÉCURITÉ ---
function verifierToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ erreur: "Token manquant." });
    const token = authHeader.split(" ")[1];
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(403).json({ erreur: "Token invalide." });
        req.userId = decoded.id; 
        next();
    });
}

// ============================================================================
// TEMPS RÉEL (WEBSOCKETS SOCKET.IO)
// ============================================================================
const utilisateursConnectes = {};

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Erreur d'authentification"));
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return next(new Error("Token invalide"));
        socket.userId = decoded.id;
        next();
    });
});

io.on('connection', (socket) => {
    utilisateursConnectes[socket.userId] = socket.id;

    socket.on('typing', (destinataireId) => {
        const target = utilisateursConnectes[destinataireId];
        if (target) io.to(target).emit('userTyping', socket.userId);
    });

    socket.on('stopTyping', (destinataireId) => {
        const target = utilisateursConnectes[destinataireId];
        if (target) io.to(target).emit('userStoppedTyping', socket.userId);
    });

    socket.on('markAsRead', (expediteurId) => {
        const target = utilisateursConnectes[expediteurId];
        if (target) io.to(target).emit('messagesReadBy', socket.userId);
    });

    socket.on('toggleEphemere', ({ cibleId, actif }) => {
        const target = utilisateursConnectes[cibleId];
        if (target) io.to(target).emit('ephemereToggled', { parId: socket.userId, actif });
    });

    socket.on('disconnect', () => {
        delete utilisateursConnectes[socket.userId];
    });
});

// ============================================================================
// ROUTES API REST
// ============================================================================

// 1. AUTHENTIFICATION
app.post('/auth/inscription', (req, res) => {
    const { pseudo, password } = req.body;
    if (!pseudo || !password) return res.status(400).json({ erreur: "Champs requis." });
    const utilisateurs = lireDB(fileUsers);
    if (utilisateurs.some(u => u.pseudo.toLowerCase() === pseudo.toLowerCase())) {
        return res.status(400).json({ erreur: "Ce pseudo est déjà pris." });
    }
    utilisateurs.push({ _id: Date.now().toString(), pseudo, password, avatarUrl: null, abonnements: [], notifications: [] });
    ecrireDB(fileUsers, utilisateurs);
    res.status(201).json({ message: "Inscription réussie." });
});

app.post('/auth/connexion', (req, res) => {
    const { pseudo, password } = req.body;
    const utilisateurs = lireDB(fileUsers);
    const user = utilisateurs.find(u => u.pseudo.toLowerCase() === pseudo.toLowerCase() && u.password === password);
    if (!user) return res.status(401).json({ erreur: "Identifiants incorrects." });
    const token = jwt.sign({ id: user._id }, SECRET_KEY, { expiresIn: '24h' });
    res.json({ token, message: "Connecté avec succès." });
});

// 2. UTILISATEURS & PROFILS
app.get('/users/me', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const publications = lireDB(filePosts);
    const moi = utilisateurs.find(u => u._id === req.userId);
    if (!moi) return res.status(404).json({ erreur: "Utilisateur introuvable" });
    const mesPosts = publications.filter(p => p.auteurId === moi._id).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ _id: moi._id, pseudo: moi.pseudo, avatarUrl: moi.avatarUrl, abonnementsCount: (moi.abonnements || []).length, mesPosts });
});

app.post('/users/me/avatar', verifierToken, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Fichier manquant." });
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    if (moi.avatarUrl) {
        const anc = path.join(__dirname, moi.avatarUrl);
        if (fs.existsSync(anc)) { try { fs.unlinkSync(anc); } catch(e){} }
    }
    moi.avatarUrl = `/uploads/${req.file.filename}`;
    ecrireDB(fileUsers, utilisateurs);
    res.json({ message: "Avatar mis à jour !", avatarUrl: moi.avatarUrl });
});

app.put('/users/me/pseudo', verifierToken, (req, res) => {
    const { nouveauPseudo } = req.body;
    if (!nouveauPseudo || !nouveauPseudo.trim()) return res.status(400).json({ erreur: "Pseudo vide." });
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    if (utilisateurs.some(u => u.pseudo.toLowerCase() === nouveauPseudo.trim().toLowerCase() && u._id !== req.userId)) {
        return res.status(400).json({ erreur: "Pseudo déjà utilisé." });
    }
    moi.pseudo = nouveauPseudo.trim();
    ecrireDB(fileUsers, utilisateurs);
    res.json({ message: "Pseudo modifié !", nouveauPseudo: moi.pseudo });
});

app.delete('/users/me', verifierToken, (req, res) => {
    let us = lireDB(fileUsers); let pubs = lireDB(filePosts); let msgs = lireDB(fileMessages); let st = lireDB(fileStatuses);
    const idx = us.findIndex(u => u._id === req.userId);
    if (idx === -1) return res.status(404).json({});
    const moi = us[idx];

    if (moi.avatarUrl) { const p = path.join(__dirname, moi.avatarUrl); if(fs.existsSync(p)){try{fs.unlinkSync(p)}catch(e){}} }
    pubs.filter(p => p.auteurId === req.userId).forEach(p => { if(p.imageUrl){const f=path.join(__dirname, p.imageUrl);if(fs.existsSync(f)){try{fs.unlinkSync(f)}catch(e){}}} });
    st.filter(s => s.userId === req.userId).forEach(s => { if(s.mediaUrl){const f=path.join(__dirname, s.mediaUrl);if(fs.existsSync(f)){try{fs.unlinkSync(f)}catch(e){}}} });

    us.splice(idx, 1);
    pubs = pubs.filter(p => p.auteurId !== req.userId);
    st = st.filter(s => s.userId !== req.userId);
    msgs = msgs.filter(m => m.fromId !== req.userId && m.toId !== req.userId);

    ecrireDB(fileUsers, us); ecrireDB(filePosts, pubs); ecrireDB(fileStatuses, st); ecrireDB(fileMessages, msgs);
    res.json({ message: "Compte supprimé." });
});

app.get('/users/search', verifierToken, (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    const us = lireDB(fileUsers);
    res.json(us.filter(u => u.pseudo.toLowerCase().includes(q) && u._id !== req.userId).map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl })));
});

app.get('/users/:id', verifierToken, (req, res) => {
    const us = lireDB(fileUsers); const pubs = lireDB(filePosts);
    const cible = us.find(u => u._id === req.params.id);
    if (!cible) return res.status(404).json({});
    if (cible._id === req.userId) return res.json({ redirectMe: true });
    const sesPosts = pubs.filter(p => p.auteurId === cible._id).sort((a, b) => new Date(b.date) - new Date(a.date));
    const moi = us.find(u => u._id === req.userId);
    res.json({ _id: cible._id, pseudo: cible.pseudo, avatarUrl: cible.avatarUrl, postsCount: sesPosts.length, estAbonne: moi.abonnements ? moi.abonnements.includes(cible._id) : false, posts: sesPosts });
});

app.post('/users/:id/follow', verifierToken, (req, res) => {
    const us = lireDB(fileUsers); const moi = us.find(u => u._id === req.userId);
    if (!moi.abonnements) moi.abonnements = [];
    if (!moi.abonnements.includes(req.params.id)) { moi.abonnements.push(req.params.id); ecrireDB(fileUsers, us); }
    res.json({ message: "Abonné !" });
});

app.post('/users/:id/unfollow', verifierToken, (req, res) => {
    const us = lireDB(fileUsers); const moi = us.find(u => u._id === req.userId);
    if (moi.abonnements) { const i = moi.abonnements.indexOf(req.params.id); if(i !== -1){ moi.abonnements.splice(i,1); ecrireDB(fileUsers, us); } }
    res.json({ message: "Désabonné." });
});

// 3. NOTIFICATIONS
app.get('/notifications', verifierToken, (req, res) => {
    const u = lireDB(fileUsers).find(user => user._id === req.userId);
    res.json(u ? (u.notifications || []) : []);
});
app.post('/notifications/read', verifierToken, (req, res) => {
    const us = lireDB(fileUsers); const moi = us.find(u => u._id === req.userId);
    if (moi && moi.notifications) { moi.notifications.forEach(n => n.read = true); ecrireDB(fileUsers, us); }
    res.json({});
});

// 4. MESSAGERIE (EXCELLENCE & PARAMÈTRES)
app.get('/messages/contacts', verifierToken, (req, res) => {
    const us = lireDB(fileUsers); const msgs = lireDB(fileMessages); const moiId = req.userId;
    let map = {};
    us.forEach(u => { if(u._id !== moiId) map[u._id] = { _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl, dernierMessage: null, dateDernierMessage: 0 }; });
    msgs.forEach(m => {
        if (m.fromId === moiId || m.toId === moiId) {
            const autreId = m.fromId === moiId ? m.toId : m.fromId;
            if (map[autreId]) {
                const t = new Date(m.date).getTime();
                if (t > map[autreId].dateDernierMessage) {
                    map[autreId].dernierMessage = m.mediaType === 'audio' ? "🎤 Message vocal" : m.texte;
                    map[autreId].dateDernierMessage = t;
                }
            }
        }
    });
    res.json(Object.values(map).sort((a, b) => b.dateDernierMessage - a.dateDernierMessage));
});

app.get('/messages/:userId', verifierToken, (req, res) => {
    const msgs = lireDB(fileMessages); const cibleId = req.params.userId; const moiId = req.userId;
    let modifie = false;
    msgs.forEach(m => {
        if (m.fromId === cibleId && m.toId === moiId && m.status !== 'read') { m.status = 'read'; modifie = true; }
    });
    if (modifie) ecrireDB(fileMessages, msgs);
    const discussion = msgs.filter(m => (m.fromId === moiId && m.toId === cibleId) || (m.fromId === cibleId && m.toId === moiId)).sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json(discussion);
});

// Envoi d'un message (Texte, Fichier Audio, Option Éphémère)
app.post('/messages/:userId', verifierToken, upload.single('media'), (req, res) => {
    const { texte, ephemere } = req.body;
    const cibleId = req.params.userId;
    let mediaUrl = null; let mediaType = null;
    if (req.file) {
        mediaUrl = `/uploads/${req.file.filename}`;
        mediaType = req.file.mimetype.startsWith('audio/') ? 'audio' : 'image';
    }
    if ((!texte || !texte.trim()) && !mediaUrl) return res.status(400).json({ erreur: "Message vide." });

    const msgs = lireDB(fileMessages);
    const nouveauMsg = {
        id: Date.now().toString(), fromId: req.userId, toId: cibleId,
        texte: texte ? texte.trim() : "", mediaUrl, mediaType,
        status: 'delivered', ephemere: ephemere === 'true', date: new Date()
    };
    msgs.push(nouveauMsg);
    ecrireDB(fileMessages, msgs);

    const targetSocket = utilisateursConnectes[cibleId];
    if (targetSocket) io.to(targetSocket).emit('newMessage', nouveauMsg);

    res.status(201).json(nouveauMsg);
});

// Suppression d'un message individuel
app.delete('/messages/:id', verifierToken, (req, res) => {
    try {
        let msgs = lireDB(fileMessages);
        const idx = msgs.findIndex(m => m.id === req.params.id);
        if (idx === -1) return res.status(404).json({ erreur: "Introuvable." });

        const m = msgs[idx];
        if (m.fromId !== req.userId && m.toId !== req.userId) {
            return res.status(403).json({ erreur: "Non autorisé." });
        }

        if (m.mediaUrl) {
            const pathMedia = path.join(__dirname, m.mediaUrl);
            if (fs.existsSync(pathMedia)) { try { fs.unlinkSync(pathMedia); } catch(e){} }
        }

        msgs.splice(idx, 1);
        ecrireDB(fileMessages, msgs);

        // Notifier la suppression en direct
        const autreId = m.fromId === req.userId ? m.toId : m.fromId;
        const targetSocket = utilisateursConnectes[autreId];
        if (targetSocket) io.to(targetSocket).emit('messageDeleted', req.params.id);

        res.json({ succes: true });
    } catch(e) { res.status(500).json({ erreur: "Erreur serveur." }); }
});

// Vider toute une conversation
app.delete('/messages/clear/:interlocuteurId', verifierToken, (req, res) => {
    try {
        const moiId = req.userId; const autreId = req.params.interlocuteurId;
        let msgs = lireDB(fileMessages);
        const restants = msgs.filter(m => !((m.fromId === moiId && m.toId === autreId) || (m.fromId === autreId && m.toId === moiId)));
        ecrireDB(fileMessages, restants);

        const targetSocket = utilisateursConnectes[autreId];
        if (targetSocket) io.to(targetSocket).emit('chatCleared', moiId);

        res.json({ succes: true });
    } catch(e) { res.status(500).json({ erreur: "Erreur serveur." }); }
});

// 5. PUBLICATIONS (FEED)
app.post('/posts', verifierToken, upload.single('image'), (req, res) => {
    const { contenu } = req.body;
    if (!contenu && !req.file) return res.status(400).json({});
    const pubs = lireDB(filePosts);
    pubs.push({
        _id: Date.now().toString(), auteurId: req.userId, contenu: contenu || "",
        imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
        mediaType: req.file ? (req.file.mimetype.startsWith('video/') ? 'video' : 'image') : null,
        likes: [], commentaires: [], date: new Date()
    });
    ecrireDB(filePosts, pubs);
    res.status(201).json({});
});

app.get('/feed', verifierToken, (req, res) => {
    const us = lireDB(fileUsers); const pubs = lireDB(filePosts);
    const moi = us.find(u => u._id === req.userId);
    if (!moi) return res.json([]);
    const valid = pubs.filter(p => p.auteurId === moi._id || (moi.abonnements && moi.abonnements.includes(p.auteurId))).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(valid.map(p => { const aut = us.find(u => u._id === p.auteurId); return { ...p, auteur: { pseudo: aut ? aut.pseudo : "Inconnu", avatarUrl: aut ? aut.avatarUrl : null }, estLeMien: p.auteurId === req.userId }; }));
});

app.post('/posts/:id/like', verifierToken, (req, res) => {
    const pubs = lireDB(filePosts); const p = pubs.find(x => x._id === req.params.id);
    if(p) { const idx = p.likes.indexOf(req.userId); if(idx === -1) { p.likes.push(req.userId); if(p.auteurId !== req.userId) ajouterNotification(p.auteurId, 'like', lireDB(fileUsers).find(u=>u._id===req.userId).pseudo, p._id); } else p.likes.splice(idx,1); ecrireDB(filePosts, pubs); }
    res.json({});
});

app.post('/posts/:id/comment', verifierToken, (req, res) => {
    const pubs = lireDB(filePosts); const p = pubs.find(x => x._id === req.params.id);
    const moi = lireDB(fileUsers).find(u => u._id === req.userId);
    if(p && req.body.texte) { p.commentaires.push({ id: Date.now().toString(), auteur: moi.pseudo, texte: req.body.texte.trim(), dateCreation: new Date() }); if(p.auteurId !== req.userId) ajouterNotification(p.auteurId, 'comment', moi.pseudo, p._id); ecrireDB(filePosts, pubs); }
    res.status(201).json({});
});

app.delete('/posts/:id', verifierToken, (req, res) => {
    let pubs = lireDB(filePosts); const p = pubs.find(x => x._id === req.params.id);
    if(p && p.auteurId === req.userId) { if(p.imageUrl){const f=path.join(__dirname,p.imageUrl);if(fs.existsSync(f)){try{fs.unlinkSync(f)}catch(e){}}} pubs = pubs.filter(x => x._id !== req.params.id); ecrireDB(filePosts, pubs); }
    res.json({});
});

// 6. STATUTS PRIVÉS 24H
app.post('/statuses', verifierToken, upload.single('statusMedia'), (req, res) => {
    const moi = lireDB(fileUsers).find(u => u._id === req.userId);
    const st = lireDB(fileStatuses);
    const n = { _id: Date.now().toString(), userId: req.userId, author: moi.pseudo, avatarUrl: moi.avatarUrl, type: req.file ? 'image':'text', mediaUrl: req.file ? `/uploads/${req.file.filename}`:null, text: req.body.texte || "", date: new Date(), vulespar: [] };
    st.unshift(n); ecrireDB(fileStatuses, st);
    res.status(201).json(n);
});

app.get('/statuses', verifierToken, (req, res) => {
    const us = lireDB(fileUsers); const moi = us.find(u => u._id === req.userId);
    if(!moi) return res.json([]);
    const m = new Date().getTime();
    const valides = lireDB(fileStatuses).filter(s => (m - new Date(s.date).getTime()) < 86400000 && (s.userId === req.userId || (moi.abonnements && moi.abonnements.includes(s.userId))));
    res.json(valides.map(s => { const aut = us.find(u => u._id === s.userId); return { ...s, author: aut ? aut.pseudo : s.author, avatarUrl: aut ? aut.avatarUrl : s.avatarUrl, read: (s.vulespar || []).includes(req.userId) }; }));
});

app.post('/statuses/:id/read', verifierToken, (req, res) => {
    const st = lireDB(fileStatuses); const s = st.find(x => x._id === req.params.id);
    if(s) { if(!s.vulespar) s.vulespar = []; if(!s.vulespar.includes(req.userId)) { s.vulespar.push(req.userId); ecrireDB(fileStatuses, st); } }
    res.json({});
});

app.delete('/statuses/:id', verifierToken, (req, res) => {
    let st = lireDB(fileStatuses); const s = st.find(x => x._id === req.params.id);
    if(s && s.userId === req.userId) { if(s.mediaUrl){const f=path.join(__dirname,s.mediaUrl);if(fs.existsSync(f)){try{fs.unlinkSync(f)}catch(e){}}} st = st.filter(x => x._id !== req.params.id); ecrireDB(fileStatuses, st); }
    res.json({});
});

// --- CRON JOB : NETTOYAGE AUTOMATIQUE DES MESSAGES ÉPHÉMÈRES (Toutes les heures) ---
setInterval(() => {
    let msgs = lireDB(fileMessages);
    const limite = Date.now() - (24 * 60 * 60 * 1000);
    const initLen = msgs.length;
    msgs = msgs.filter(m => !(m.ephemere && new Date(m.date).getTime() < limite));
    if (msgs.length !== initLen) {
        ecrireDB(fileMessages, msgs);
        console.log("⏱️ Nettoyage : anciens messages éphémères supprimés.");
    }
}, 3600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur WebSockets en ligne sur le port ${PORT}`));