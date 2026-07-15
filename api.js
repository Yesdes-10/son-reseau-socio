const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// --- IMPORT WEBSOCKETS ---
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

// --- INITIALISATION DU SERVEUR HTTP ET SOCKET.IO ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});

// Servir les fichiers statiques du front et des uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'frontend')));

const SECRET_KEY = "ma_cle_secrete_reseau_social";
const fileUsers = path.join(__dirname, 'utilisateurs.json');
const filePosts = path.join(__dirname, 'publications.json');
const fileMessages = path.join(__dirname, 'messages.json');
const fileStatuses = path.join(__dirname, 'statuts.json');

// --- CONFIGURATION DE STORAGE (MULTER) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const nomUnique = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, nomUnique);
    }
});
const upload = multer({ storage: storage });

// --- GESTIONNAIRES DE BASE DE DONNÉES ---
function lireDB(fichier) {
    if (!fs.existsSync(fichier)) { fs.writeFileSync(fichier, JSON.stringify([])); return []; }
    try { return JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch(e) { return []; }
}
function ecrireDB(fichier, donnees) { fs.writeFileSync(fichier, JSON.stringify(donnees, null, 2)); }

// --- UTILITAIRE DE SUPPRESSION DE FICHIER PHYSIQUE (ANTI-FUITE DE DISQUE) ---
function supprimerFichierPhysique(urlRelative) {
    if (!urlRelative) return;
    try {
        // Enlève le slash initial pour éviter les bugs de path.join
        const cheminNettoye = urlRelative.startsWith('/') ? urlRelative.slice(1) : urlRelative;
        const cheminAbsolu = path.join(__dirname, cheminNettoye);
        if (fs.existsSync(cheminAbsolu)) {
            fs.unlinkSync(cheminAbsolu);
        }
    } catch (e) {
        console.error("Erreur lors de la suppression du fichier :", e.message);
    }
}

// --- SYSTEME DE NOTIFICATIONS ---
function ajouterNotification(userId, type, fromPseudo, postId) {
    const utilisateurs = lireDB(fileUsers);
    const user = utilisateurs.find(u => u._id === userId);
    if (user) {
        if (!user.notifications) user.notifications = [];
        user.notifications.unshift({
            id: Date.now().toString(), type: type, fromPseudo: fromPseudo, postId: postId, read: false, date: new Date()
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
        req.userId = decoded.id; next();
    });
}

// ============================================================================
// GESTION TEMPS RÉEL (WEBSOCKETS VIA ROOMS)
// ============================================================================
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
    // Utilisation des "Rooms" natives de Socket.io (permet le multi-appareils sans bug)
    socket.join(socket.userId);

    socket.on('typing', (destinataireId) => {
        io.to(destinataireId).emit('userTyping', socket.userId);
    });

    socket.on('stopTyping', (destinataireId) => {
        io.to(destinataireId).emit('userStoppedTyping', socket.userId);
    });

    socket.on('markAsRead', (expediteurId) => {
        io.to(expediteurId).emit('messagesReadBy', socket.userId);
    });

    socket.on('disconnect', () => {
        // Socket.io gère automatiquement la sortie des rooms
    });
});

// ============================================================================
// CONFIGURATION DES ROUTES
// ============================================================================

// --- 1. AUTHENTIFICATION ---
app.post('/auth/inscription', (req, res) => {
    const { pseudo, password } = req.body;
    if (!pseudo || !password) return res.status(400).json({ erreur: "Champs requis." });
    const utilisateurs = lireDB(fileUsers);
    if (utilisateurs.find(u => u.pseudo.toLowerCase() === pseudo.trim().toLowerCase())) {
        return res.status(400).json({ erreur: "Ce pseudo est déjà pris." });
    }
    utilisateurs.push({ _id: Date.now().toString(), pseudo: pseudo.trim(), password, avatarUrl: null, abonnements: [], notifications: [] });
    ecrireDB(fileUsers, utilisateurs);
    res.status(201).json({ message: "Inscription réussie." });
});

app.post('/auth/connexion', (req, res) => {
    const { pseudo, password } = req.body;
    const utilisateurs = lireDB(fileUsers);
    const user = utilisateurs.find(u => u.pseudo.toLowerCase() === pseudo.trim().toLowerCase() && u.password === password);
    if (!user) return res.status(401).json({ erreur: "Identifiants incorrects." });
    const token = jwt.sign({ id: user._id }, SECRET_KEY, { expiresIn: '24h' });
    res.json({ token, message: "Connecté avec succès." });
});

// --- 2. GESTION DES UTILISATEURS ---
app.get('/users/me', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const publications = lireDB(filePosts);
    const moi = utilisateurs.find(u => u._id === req.userId);
    if (!moi) return res.status(404).json({ erreur: "Utilisateur non trouvé" });
    const mesPosts = publications.filter(p => p.auteurId === moi._id).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ _id: moi._id, pseudo: moi.pseudo, avatarUrl: moi.avatarUrl, abonnementsCount: (moi.abonnements || []).length, mesPosts: mesPosts });
});

app.post('/users/me/avatar', verifierToken, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier fourni." });
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    
    // Suppression de l'ancien avatar du disque
    if (moi.avatarUrl) supprimerFichierPhysique(moi.avatarUrl);

    moi.avatarUrl = `/uploads/${req.file.filename}`;
    ecrireDB(fileUsers, utilisateurs);
    res.json({ message: "Photo de profil mise à jour !", avatarUrl: moi.avatarUrl });
});

app.put('/users/me/pseudo', verifierToken, (req, res) => {
    const { nouveauPseudo } = req.body;
    if (!nouveauPseudo || nouveauPseudo.trim() === "") return res.status(400).json({ erreur: "Le pseudo ne peut pas être vide." });
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    if (utilisateurs.some(u => u.pseudo.toLowerCase() === nouveauPseudo.trim().toLowerCase() && u._id !== req.userId)) {
        return res.status(400).json({ erreur: "Ce pseudo est déjà pris." });
    }
    moi.pseudo = nouveauPseudo.trim();
    ecrireDB(fileUsers, utilisateurs);
    res.json({ message: "Pseudo mis à jour avec succès !", nouveauPseudo: moi.pseudo });
});

app.delete('/users/me', verifierToken, (req, res) => {
    let utilisateurs = lireDB(fileUsers); let publications = lireDB(filePosts);
    let messages = lireDB(fileMessages); let statuts = lireDB(fileStatuses);
    const index = utilisateurs.findIndex(u => u._id === req.userId);
    if (index === -1) return res.status(404).json({ erreur: "Compte introuvable." });
    const moi = utilisateurs[index];

    // 1. Suppression physique de tous les fichiers de l'utilisateur
    if (moi.avatarUrl) supprimerFichierPhysique(moi.avatarUrl);
    publications.filter(p => p.auteurId === req.userId).forEach(p => supprimerFichierPhysique(p.imageUrl));
    statuts.filter(s => s.userId === req.userId).forEach(s => supprimerFichierPhysique(s.mediaUrl));
    
    // NOUVEAU : Supprimer aussi les fichiers médias dans les messages de l'utilisateur
    messages.filter(m => m.fromId === req.userId || m.toId === req.userId).forEach(m => {
        if (m.mediaUrl) supprimerFichierPhysique(m.mediaUrl);
    });

    // 2. Nettoyage des tableaux JSON
    utilisateurs.splice(index, 1);
    publications = publications.filter(p => p.auteurId !== req.userId);
    statuts = statuts.filter(s => s.userId !== req.userId);
    messages = messages.filter(m => m.fromId !== req.userId && m.toId !== req.userId);

    ecrireDB(fileUsers, utilisateurs); ecrireDB(filePosts, publications);
    ecrireDB(fileStatuses, statuts); ecrireDB(fileMessages, messages);
    res.json({ message: "Compte et données supprimés définitivement." });
});

app.get('/users/search', verifierToken, (req, res) => {
    const recherche = (req.query.q || "").toLowerCase();
    const utilisateurs = lireDB(fileUsers);
    const resultats = utilisateurs.filter(u => u.pseudo.toLowerCase().includes(recherche) && u._id !== req.userId)
        .map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl }));
    res.json(resultats);
});

app.get('/users/:id', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const publications = lireDB(filePosts);
    const cible = utilisateurs.find(u => u._id === req.params.id);
    if (!cible) return res.status(404).json({ erreur: "Utilisateur introuvable" });
    if (cible._id === req.userId) return res.json({ redirectMe: true });
    const sesPosts = publications.filter(p => p.auteurId === cible._id).sort((a, b) => new Date(b.date) - new Date(a.date));
    const moi = utilisateurs.find(u => u._id === req.userId);
    res.json({ _id: cible._id, pseudo: cible.pseudo, avatarUrl: cible.avatarUrl, postsCount: sesPosts.length, estAbonne: moi.abonnements ? moi.abonnements.includes(cible._id) : false, posts: sesPosts });
});

app.post('/users/:id/follow', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    const aSuivre = utilisateurs.find(u => u._id === req.params.id);
    if (!aSuivre) return res.status(404).json({ erreur: "Utilisateur cible introuvable." });
    if (!moi.abonnements) moi.abonnements = [];
    if (!moi.abonnements.includes(aSuivre._id)) { moi.abonnements.push(aSuivre._id); ecrireDB(fileUsers, utilisateurs); }
    res.json({ message: `Vous suivez maintenant @${aSuivre.pseudo} !` });
});

app.post('/users/:id/unfollow', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    if (moi.abonnements) {
        const index = moi.abonnements.indexOf(req.params.id);
        if (index !== -1) moi.abonnements.splice(index, 1);
        ecrireDB(fileUsers, utilisateurs);
    }
    res.json({ message: "Vous ne suivez plus cet utilisateur." });
});

// --- 3. NOTIFICATIONS ---
app.get('/notifications', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    res.json(moi ? (moi.notifications || []) : []);
});

app.post('/notifications/read', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    if (moi && moi.notifications) { moi.notifications.forEach(n => n.read = true); ecrireDB(fileUsers, utilisateurs); }
    res.json({ message: "Notifications lues" });
});

// --- 4. MESSAGERIE (CHATS) ---
app.get('/messages/contacts', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const messages = lireDB(fileMessages); const moiId = req.userId;
    let contactsMap = {};
    utilisateurs.forEach(u => {
        if (u._id !== moiId) contactsMap[u._id] = { _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl, dernierMessage: null, dateDernierMessage: 0 };
    });
    messages.forEach(m => {
        if (m.fromId === moiId || m.toId === moiId) {
            const interlocuteurId = m.fromId === moiId ? m.toId : m.fromId;
            if (contactsMap[interlocuteurId]) {
                const timestampMsg = new Date(m.date).getTime();
                if (timestampMsg > contactsMap[interlocuteurId].dateDernierMessage) {
                    contactsMap[interlocuteurId].dernierMessage = m.mediaType === 'audio' ? "🎤 Message vocal" : (m.mediaType === 'image' ? "📷 Photo" : m.texte);
                    contactsMap[interlocuteurId].dateDernierMessage = timestampMsg;
                }
            }
        }
    });
    res.json(Object.values(contactsMap).sort((a, b) => b.dateDernierMessage - a.dateDernierMessage));
});

app.get('/messages/:userId', verifierToken, (req, res) => {
    const messages = lireDB(fileMessages); const cibleId = req.params.userId; const moiId = req.userId;
    let modifie = false;
    messages.forEach(m => {
        if (m.fromId === cibleId && m.toId === moiId && m.status !== 'read') { m.status = 'read'; modifie = true; }
    });
    if (modifie) {
        ecrireDB(fileMessages, messages);
        // Notifier l'expéditeur que ses messages ont été lus !
        io.to(cibleId).emit('messagesReadBy', moiId);
    }
    const discussion = messages.filter(m => (m.fromId === moiId && m.toId === cibleId) || (m.fromId === cibleId && m.toId === moiId)).sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json(discussion);
});

app.delete('/messages/:id', verifierToken, (req, res) => {
    try {
        const messageId = req.params.id;
        const userId = req.userId;
        let messages = lireDB(fileMessages);
        const indexMessage = messages.findIndex(m => m.id === messageId);
        
        if (indexMessage === -1) return res.status(404).json({ erreur: "Message introuvable." });
        const message = messages[indexMessage];

        if (message.fromId !== userId && message.toId !== userId) {
            return res.status(403).json({ erreur: "Tu n'es pas autorisé à supprimer ce message." });
        }

        if (message.mediaUrl) supprimerFichierPhysique(message.mediaUrl);

        messages.splice(indexMessage, 1);
        ecrireDB(fileMessages, messages);

        // NOUVEAU : Notification temps réel aux deux utilisateurs de la suppression
        io.to(message.fromId).to(message.toId).emit('messageDeleted', messageId);

        res.status(200).json({ succes: true, message: "Message supprimé avec succès." });
    } catch (erreur) {
        console.error("Erreur API suppression message :", erreur);
        res.status(500).json({ erreur: "Erreur interne du serveur lors de la suppression." });
    }
});

app.post('/messages/:userId', verifierToken, upload.single('media'), (req, res) => {
    const texte = req.body.texte;
    const cibleId = req.params.userId;
    let mediaUrl = null; let mediaType = null;
    if (req.file) {
        mediaUrl = `/uploads/${req.file.filename}`;
        mediaType = req.file.mimetype.startsWith('audio/') ? 'audio' : 'image';
    }
    if ((!texte || !texte.trim()) && !mediaUrl) return res.status(400).json({ erreur: "Le message ne peut pas être vide." });

    const messages = lireDB(fileMessages);
    const nouveauMsg = {
        id: Date.now().toString(), fromId: req.userId, toId: cibleId,
        texte: texte ? texte.trim() : "", mediaUrl: mediaUrl, mediaType: mediaType, status: 'delivered', date: new Date()
    };
    messages.push(nouveauMsg);
    ecrireDB(fileMessages, messages);

    // TEMPS RÉEL VIA ROOM SOCKET.IO
    io.to(cibleId).emit('newMessage', nouveauMsg);

    res.status(201).json(nouveauMsg);
});

// --- 5. PUBLICATIONS (FEED) ---
app.post('/posts', verifierToken, upload.single('image'), (req, res) => {
    const { contenu } = req.body;
    if (!contenu && !req.file) return res.status(400).json({ erreur: "Le post ne peut pas être vide." });
    const publications = lireDB(filePosts);
    let mediaType = null;
    if (req.file) mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const nouveauPost = {
        _id: Date.now().toString(), auteurId: req.userId, contenu: contenu || "",
        imageUrl: req.file ? `/uploads/${req.file.filename}` : null, mediaType: mediaType, likes: [], commentaires: [], date: new Date()
    };
    publications.push(nouveauPost);
    ecrireDB(filePosts, publications);
    res.status(201).json({ message: "Publié !" });
});

app.get('/feed', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const publications = lireDB(filePosts);
    const moi = utilisateurs.find(u => u._id === req.userId);
    if (!moi) return res.json([]);
    const postsAafficher = publications.filter(p => p.auteurId === moi._id || (moi.abonnements && moi.abonnements.includes(p.auteurId)));
    postsAafficher.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    const postsComplets = postsAafficher.map(post => {
        const auteur = utilisateurs.find(u => u._id === post.auteurId);
        // Mise à jour dynamique des pseudos/avatars dans les commentaires aussi !
        const commentairesAjour = (post.commentaires || []).map(c => {
            const auteurCom = utilisateurs.find(u => u._id === (c.auteurId || c.userId));
            return {
                ...c,
                auteur: auteurCom ? auteurCom.pseudo : c.auteur,
                avatarUrl: auteurCom ? auteurCom.avatarUrl : c.avatarUrl
            };
        });
        return { 
            ...post, 
            auteur: { pseudo: auteur ? auteur.pseudo : "Inconnu", avatarUrl: auteur ? auteur.avatarUrl : null }, 
            commentaires: commentairesAjour,
            estLeMien: post.auteurId === req.userId 
        };
    });
    res.json(postsComplets);
});

app.post('/posts/:id/like', verifierToken, (req, res) => {
    const publications = lireDB(filePosts); const utilisateurs = lireDB(fileUsers);
    const post = publications.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Post introuvable." });
    const moi = utilisateurs.find(u => u._id === req.userId);
    const index = post.likes.indexOf(req.userId);
    if (index === -1) {
        post.likes.push(req.userId);
        if (post.auteurId !== req.userId) ajouterNotification(post.auteurId, 'like', moi.pseudo, post._id);
    } else {
        post.likes.splice(index, 1);
    }
    ecrireDB(filePosts, publications);
    res.json({ message: "Like mis à jour" });
});

app.post('/posts/:id/comment', verifierToken, (req, res) => {
    const publications = lireDB(filePosts); const utilisateurs = lireDB(fileUsers);
    const post = publications.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Post introuvable" });
    const moi = utilisateurs.find(u => u._id === req.userId);
    const { texte } = req.body;
    if (!texte || !texte.trim()) return res.status(400).json({ erreur: "Texte vide." });
    
    // NOUVEAU : Ajout de auteurId et avatarUrl pour que les commentaires s'actualisent et s'affichent correctement
    post.commentaires.push({ 
        id: Date.now().toString(), 
        auteurId: moi._id, 
        auteur: moi.pseudo, 
        avatarUrl: moi.avatarUrl,
        texte: texte.trim(), 
        dateCreation: new Date() 
    });
    
    if (post.auteurId !== req.userId) ajouterNotification(post.auteurId, 'comment', moi.pseudo, post._id);
    ecrireDB(filePosts, publications);
    res.status(201).json({ message: "Commentaire ajouté" });
});

app.delete('/posts/:id', verifierToken, (req, res) => {
    let publications = lireDB(filePosts);
    const index = publications.findIndex(p => p._id === req.params.id);
    if (index === -1) return res.status(404).json({ erreur: "Post introuvable." });
    if (publications[index].auteurId !== req.userId) return res.status(403).json({ erreur: "Interdit." });
    
    if (publications[index].imageUrl) supprimerFichierPhysique(publications[index].imageUrl);
    
    publications = publications.filter(x => x._id !== req.params.id);
    ecrireDB(filePosts, publications);
    res.json({ message: "Post supprimé !" });
});

// --- 6. GESTION DES STATUTS PRIVÉS ---
app.post('/statuses', verifierToken, upload.single('statusMedia'), (req, res) => {
    const { texte } = req.body;
    if (!texte && !req.file) return res.status(400).json({ erreur: "Le statut ne peut pas être vide." });
    const utilisateurs = lireDB(fileUsers); const moi = utilisateurs.find(u => u._id === req.userId);
    const statuts = lireDB(fileStatuses);
    const nouveauStatut = {
        _id: Date.now().toString(), userId: req.userId, author: moi.pseudo, avatarUrl: moi.avatarUrl,
        type: req.file ? 'image' : 'text', mediaUrl: req.file ? `/uploads/${req.file.filename}` : null, text: texte || "", date: new Date(), vulespar: []
    };
    statuts.unshift(nouveauStatut);
    ecrireDB(fileStatuses, statuts);
    res.status(201).json(nouveauStatut);
});

app.get('/statuses', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers); const statutsAll = lireDB(fileStatuses);
    const moi = utilisateurs.find(u => u._id === req.userId);
    if (!moi) return res.json([]);
    const maintenant = new Date().getTime(); const limite24h = 24 * 60 * 60 * 1000;
    const statutsValides = statutsAll.filter(s => {
        const estRecent = (maintenant - new Date(s.date).getTime()) < limite24h;
        const estDeMesContacts = s.userId === req.userId || (moi.abonnements && moi.abonnements.includes(s.userId));
        return estRecent && estDeMesContacts;
    });
    const rendus = statutsValides.map(s => {
        const auteur = utilisateurs.find(u => u._id === s.userId);
        return { ...s, author: auteur ? auteur.pseudo : s.author, avatarUrl: auteur ? auteur.avatarUrl : s.avatarUrl, read: s.vulespar ? s.vulespar.includes(req.userId) : false };
    });
    res.json(rendus);
});

app.post('/statuses/:id/read', verifierToken, (req, res) => {
    const statuts = lireDB(fileStatuses); const statut = statuts.find(s => s._id === req.params.id);
    if (statut) {
        if (!statut.vulespar) statut.vulespar = [];
        if (!statut.vulespar.includes(req.userId)) { statut.vulespar.push(req.userId); ecrireDB(fileStatuses, statuts); }
    }
    res.json({ message: "Marqué comme lu" });
});

app.delete('/statuses/:id', verifierToken, (req, res) => {
    let statuts = lireDB(fileStatuses); const index = statuts.findIndex(s => s._id === req.params.id);
    if (index === -1) return res.status(404).json({ erreur: "Statut introuvable." });
    if (statuts[index].userId !== req.userId) return res.status(403).json({ erreur: "Interdit." });
    
    if (statuts[index].mediaUrl) supprimerFichierPhysique(statuts[index].mediaUrl);
    
    statuts = statuts.filter(x => x._id !== req.params.id);
    ecrireDB(fileStatuses, statuts);
    res.json({ message: "Statut supprimé !" });
});

// --- VIDER TOUTE UNE CONVERSATION ---
app.delete('/messages/clear/:interlocuteurId', verifierToken, (req, res) => {
    try {
        const moiId = req.userId;
        const autreId = req.params.interlocuteurId;

        let messages = lireDB(fileMessages);

        // NOUVEAU : Supprimer les fichiers physiques des messages de cette discussion avant d'effacer
        messages.forEach(m => {
            const estDansLaDiscussion = (m.fromId === moiId && m.toId === autreId) || (m.fromId === autreId && m.toId === moiId);
            if (estDansLaDiscussion && m.mediaUrl) {
                supprimerFichierPhysique(m.mediaUrl);
            }
        });

        const messagesRestants = messages.filter(m => {
            const estDansLaDiscussion = (m.fromId === moiId && m.toId === autreId) || (m.fromId === autreId && m.toId === moiId);
            return !estDansLaDiscussion;
        });

        ecrireDB(fileMessages, messagesRestants);

        // Notifier l'interlocuteur via les rooms Socket.io
        io.to(autreId).emit('chatCleared', moiId);

        res.json({ succes: true, message: "Historique de discussion supprimé." });
    } catch (e) {
        console.error("Erreur vidage chat :", e);
        res.status(500).json({ erreur: "Erreur serveur." });
    }
});

// --- NETTOYAGE AUTOMATIQUE DES MESSAGES ÉPHÉMÈRES (Toutes les heures) ---
setInterval(() => {
    let messages = lireDB(fileMessages);
    const limite24h = Date.now() - (24 * 60 * 60 * 1000);
    let messagesModifies = false;

    messages = messages.filter(m => {
        if (m.ephemere && new Date(m.date).getTime() < limite24h) {
            if (m.mediaUrl) supprimerFichierPhysique(m.mediaUrl); // Supprime le média du disque !
            messagesModifies = true;
            return false;
        }
        return true;
    });

    if (messagesModifies) {
        ecrireDB(fileMessages, messages);
        console.log("⏱️ Nettoyage automatique : anciens messages éphémères supprimés.");
    }
}, 60 * 60 * 1000);

// --- EXECUTION DU SERVEUR VIA HTTP ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur WebSockets et API en ligne sur le port ${PORT}`));