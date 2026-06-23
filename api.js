const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'frontend')));

const SECRET_KEY = "ma_cle_secrete_reseau_social";
const fileUsers = path.join(__dirname, 'utilisateurs.json');
const filePosts = path.join(__dirname, 'publications.json');
const fileMessages = path.join(__dirname, 'messages.json');

// --- CONFIGURATION FICHIERS ---
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

function lireDB(fichier) {
    if (!fs.existsSync(fichier)) {
        fs.writeFileSync(fichier, JSON.stringify([]));
        return [];
    }
    return JSON.parse(fs.readFileSync(fichier, 'utf8'));
}

function ecrireDB(fichier, donnees) {
    fs.writeFileSync(fichier, JSON.stringify(donnees, null, 2));
}

// Système de notifications automatique
function ajouterNotification(userId, type, fromPseudo, postId) {
    const utilisateurs = lireDB(fileUsers);
    const user = utilisateurs.find(u => u._id === userId);
    if (user) {
        if (!user.notifications) user.notifications = [];
        user.notifications.unshift({
            id: Date.now().toString(),
            type: type,
            fromPseudo: fromPseudo,
            postId: postId,
            read: false,
            date: new Date()
        });
        ecrireDB(fileUsers, utilisateurs);
    }
}

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

// --- AUTHENTIFICATION ---
app.post('/auth/inscription', (req, res) => {
    const { pseudo, password } = req.body;
    if (!pseudo || !password) return res.status(400).json({ erreur: "Champs requis." });
    
    const utilisateurs = lireDB(fileUsers);
    if (utilisateurs.find(u => u.pseudo === pseudo)) {
        return res.status(400).json({ erreur: "Ce pseudo est déjà pris." });
    }

    utilisateurs.push({
        _id: Date.now().toString(),
        pseudo, password, avatarUrl: null, abonnements: [], notifications: []
    });
    ecrireDB(fileUsers, utilisateurs);
    res.status(201).json({ message: "Inscription réussie." });
});

app.post('/auth/connexion', (req, res) => {
    const { pseudo, password } = req.body;
    const utilisateurs = lireDB(fileUsers);
    const user = utilisateurs.find(u => u.pseudo === pseudo && u.password === password);
    
    if (!user) return res.status(401).json({ erreur: "Identifiants incorrects." });

    const token = jwt.sign({ id: user._id }, SECRET_KEY, { expiresIn: '24h' });
    res.json({ token, message: "Connecté avec succès." });
});

// --- GESTION UTILISATEURS ---
app.get('/users/me', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const publications = lireDB(filePosts);
    const moi = utilisateurs.find(u => u._id === req.userId);
    if (!moi) return res.status(404).json({ erreur: "Utilisateur non trouvé" });

    const mesPosts = publications.filter(p => p.auteurId === moi._id).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ pseudo: moi.pseudo, avatarUrl: moi.avatarUrl, abonnementsCount: (moi.abonnements || []).length, mesPosts: mesPosts });
});

app.post('/users/me/avatar', verifierToken, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ erreur: "Aucun fichier fourni." });
    const utilisateurs = lireDB(fileUsers);
    const moi = utilisateurs.find(u => u._id === req.userId);

    if (moi.avatarUrl) {
        const ancienChemin = path.join(__dirname, moi.avatarUrl);
        if (fs.existsSync(ancienChemin)) fs.unlinkSync(ancienChemin);
    }
    moi.avatarUrl = `/uploads/${req.file.filename}`;
    ecrireDB(fileUsers, utilisateurs);
    res.json({ message: "Photo de profil mise à jour !", avatarUrl: moi.avatarUrl });
});

app.put('/users/me/pseudo', verifierToken, (req, res) => {
    const { nouveauPseudo } = req.body;
    if (!nouveauPseudo || nouveauPseudo.trim() === "") return res.status(400).json({ erreur: "Le pseudo ne peut pas être vide." });
    const utilisateurs = lireDB(fileUsers);
    const moi = utilisateurs.find(u => u._id === req.userId);

    if (utilisateurs.some(u => u.pseudo === nouveauPseudo.trim() && u._id !== req.userId)) {
        return res.status(400).json({ erreur: "Ce pseudo est déjà pris." });
    }
    moi.pseudo = nouveauPseudo.trim();
    ecrireDB(fileUsers, utilisateurs);
    res.json({ message: "Pseudo mis à jour avec succès !", nouveauPseudo: moi.pseudo });
});

app.delete('/users/me', verifierToken, (req, res) => {
    let utilisateurs = lireDB(fileUsers);
    let publications = lireDB(filePosts);
    let messages = lireDB(fileMessages);

    const index = utilisateurs.findIndex(u => u._id === req.userId);
    const moi = utilisateurs[index];
    if (moi && moi.avatarUrl) {
        const ancienChemin = path.join(__dirname, moi.avatarUrl);
        if (fs.existsSync(ancienChemin)) fs.unlinkSync(ancienChemin);
    }

    utilisateurs.splice(index, 1);
    publications = publications.filter(p => p.auteurId !== req.userId);
    messages = messages.filter(m => m.fromId !== req.userId && m.toId !== req.userId);

    ecrireDB(fileUsers, utilisateurs);
    ecrireDB(filePosts, publications);
    ecrireDB(fileMessages, messages);
    res.json({ message: "Compte supprimé définitivement." });
});

app.get('/users/search', verifierToken, (req, res) => {
    const recherche = (req.query.q || "").toLowerCase();
    const utilisateurs = lireDB(fileUsers);
    const resultats = utilisateurs.filter(u => u.pseudo.toLowerCase().includes(recherche) && u._id !== req.userId)
        .map(u => ({ _id: u._id, pseudo: u.pseudo, avatarUrl: u.avatarUrl }));
    res.json(resultats);
});

app.get('/users/:id', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const publications = lireDB(filePosts);
    const cible = utilisateurs.find(u => u._id === req.params.id);
    if (!cible) return res.status(404).json({ erreur: "Utilisateur introuvable" });
    if (cible._id === req.userId) return res.json({ redirectMe: true });

    const sesPosts = publications.filter(p => p.auteurId === cible._id).sort((a, b) => new Date(b.date) - new Date(a.date));
    const moi = utilisateurs.find(u => u._id === req.userId);

    res.json({
        _id: cible._id, pseudo: cible.pseudo, avatarUrl: cible.avatarUrl, postsCount: sesPosts.length,
        estAbonne: moi.abonnements ? moi.abonnements.includes(cible._id) : false, posts: sesPosts
    });
});

app.post('/users/:id/follow', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const moi = utilisateurs.find(u => u._id === req.userId);
    const aSuivre = utilisateurs.find(u => u._id === req.params.id);

    if (!aSuivre) return res.status(404).json({ erreur: "Utilisateur cible introuvable." });

    if (!moi.abonnements) moi.abonnements = [];
    if (!moi.abonnements.includes(aSuivre._id)) {
        moi.abonnements.push(aSuivre._id);
        ecrireDB(fileUsers, utilisateurs);
    }
    res.json({ message: `Vous suivez maintenant @${aSuivre.pseudo} !` });
});

app.post('/users/:id/unfollow', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const moi = utilisateurs.find(u => u._id === req.userId);

    if (moi.abonnements) {
        const index = moi.abonnements.indexOf(req.params.id);
        if (index !== -1) moi.abonnements.splice(index, 1);
        ecrireDB(fileUsers, utilisateurs);
    }
    res.json({ message: "Vous ne suivez plus cet utilisateur." });
});

// --- NOTIFICATIONS ---
app.get('/notifications', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const moi = utilisateurs.find(u => u._id === req.userId);
    res.json(moi.notifications || []);
});

app.post('/notifications/read', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const moi = utilisateurs.find(u => u._id === req.userId);
    if (moi.notifications) {
        moi.notifications.forEach(n => n.read = true);
        ecrireDB(fileUsers, utilisateurs);
    }
    res.json({ message: "Notifications lues" });
});

// --- MESSAGERIE ---
app.get('/messages/contacts', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const messages = lireDB(fileMessages);
    const moiId = req.userId;

    let contactsMap = {};

    // 1. Initialiser tous les utilisateurs (sauf nous-même)
    utilisateurs.forEach(u => {
        if (u._id !== moiId) {
            contactsMap[u._id] = {
                _id: u._id,
                pseudo: u.pseudo,
                avatarUrl: u.avatarUrl,
                dernierMessage: null,
                dateDernierMessage: 0
            };
        }
    });

    // 2. Trouver le tout dernier message de chaque conversation
    messages.forEach(m => {
        if (m.fromId === moiId || m.toId === moiId) {
            const interlocuteurId = m.fromId === moiId ? m.toId : m.fromId;
            if (contactsMap[interlocuteurId]) {
                const timestampMsg = new Date(m.date).getTime();
                if (timestampMsg > contactsMap[interlocuteurId].dateDernierMessage) {
                    contactsMap[interlocuteurId].dernierMessage = m.texte;
                    contactsMap[interlocuteurId].dateDernierMessage = timestampMsg;
                }
            }
        }
    });

    // 3. Trier : les conversations actives en premier
    const contactsTries = Object.values(contactsMap).sort((a, b) => b.dateDernierMessage - a.dateDernierMessage);
    res.json(contactsTries);
});

app.get('/messages/:userId', verifierToken, (req, res) => {
    const messages = lireDB(fileMessages);
    const cibleId = req.params.userId;
    const discussion = messages.filter(m =>
        (m.fromId === req.userId && m.toId === cibleId) || (m.fromId === cibleId && m.toId === req.userId)
    ).sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json(discussion);
});

app.post('/messages/:userId', verifierToken, (req, res) => {
    const { texte } = req.body;
    const cibleId = req.params.userId;
    if (!texte || !texte.trim()) return res.status(400).json({ erreur: "Message vide." });

    const messages = lireDB(fileMessages);
    const nouveauMsg = { id: Date.now().toString(), fromId: req.userId, toId: cibleId, texte: texte.trim(), date: new Date() };
    messages.push(nouveauMsg);
    ecrireDB(fileMessages, messages);
    res.status(201).json(nouveauMsg);
});

// --- POSTS ---
app.post('/posts', verifierToken, upload.single('image'), (req, res) => {
    const { contenu } = req.body;
    if (!contenu && !req.file) return res.status(400).json({ erreur: "Le post ne peut pas être vide." });

    const publications = lireDB(filePosts);

    let mediaType = null;
    if (req.file) {
        mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    }

    const nouveauPost = {
        _id: Date.now().toString(),
        auteurId: req.userId,
        contenu: contenu || "",
        imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
        mediaType: mediaType,
        likes: [],
        commentaires: [],
        date: new Date()
    };
    publications.push(nouveauPost);
    ecrireDB(filePosts, publications);
    res.status(201).json({ message: "Publié !" });
});

app.get('/feed', verifierToken, (req, res) => {
    const utilisateurs = lireDB(fileUsers);
    const publications = lireDB(filePosts);
    const moi = utilisateurs.find(u => u._id === req.userId);
    
    const postsAafficher = publications.filter(p => p.auteurId === moi._id || (moi.abonnements && moi.abonnements.includes(p.auteurId)));
    postsAafficher.sort((a, b) => new Date(b.date) - new Date(a.date));

    const postsComplets = postsAafficher.map(post => {
        const auteur = utilisateurs.find(u => u._id === post.auteurId);
        return { ...post, auteur: { pseudo: auteur ? auteur.pseudo : "Inconnu", avatarUrl: auteur ? auteur.avatarUrl : null }, estLeMien: post.auteurId === req.userId };
    });
    res.json(postsComplets);
});

app.post('/posts/:id/like', verifierToken, (req, res) => {
    const publications = lireDB(filePosts);
    const utilisateurs = lireDB(fileUsers);
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
    const publications = lireDB(filePosts);
    const utilisateurs = lireDB(fileUsers);
    const post = publications.find(p => p._id === req.params.id);
    if (!post) return res.status(404).json({ erreur: "Post introuvable" });

    const moi = utilisateurs.find(u => u._id === req.userId);
    const { texte } = req.body;
    if (!texte || !texte.trim()) return res.status(400).json({ erreur: "Texte vide." });

    post.commentaires.push({ id: Date.now().toString(), auteur: moi.pseudo, texte: texte.trim(), dateCreation: new Date() });

    if (post.auteurId !== req.userId) ajouterNotification(post.auteurId, 'comment', moi.pseudo, post._id);
    ecrireDB(filePosts, publications);
    res.status(201).json({ message: "Commentaire ajouté" });
});

app.delete('/posts/:id', verifierToken, (req, res) => {
    const publications = lireDB(filePosts);
    const index = publications.findIndex(p => p._id === req.params.id);
    
    if (index === -1) return res.status(404).json({ erreur: "Post introuvable." });
    if (publications[index].auteurId !== req.userId) return res.status(403).json({ erreur: "Interdit." });

    if (publications[index].imageUrl) {
        const cheminImage = path.join(__dirname, publications[index].imageUrl);
        if (fs.existsSync(cheminImage)) fs.unlinkSync(cheminImage);
    }

    publications.splice(index, 1);
    ecrireDB(filePosts, publications);
    res.json({ message: "Post supprimé !" });
});

// LANCEMENT SERVEUR (Unique et tout en bas)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur en ligne sur le port ${PORT}`));