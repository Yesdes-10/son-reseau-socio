// --- VARIABLES D'ÉTAT GLOBALES ---
let token = localStorage.getItem('token');
let currentUser = null;
let cropper = null;
let currentChatUserId = null;
let socket = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingInterval = null;
let recordingSeconds = 0;

// Options du chat en cours
let chatOptions = {
    ephemere: false,
    couleur: '#dfb142',
    fond: 'default',
    mute: false
};

const API_URL = ""; // Laissez vide car le frontend est servi par Express sur le même port

// ============================================================================
// 1. INITIALISATION & CONNEXION WEBSOCKETS
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    if (token) {
        initSocket();
        chargerProfil();
        chargerFeed();
    } else {
        afficherEcran('auth-screen');
    }
});

function initSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('connect', () => console.log('🟢 Connecté aux WebSockets temps réel'));

    socket.on('newMessage', (msg) => {
        if (!chatOptions.mute) jouerSonMessage();
        if (currentChatUserId === msg.fromId) {
            ajouterMessageUI(msg);
            socket.emit('markAsRead', msg.fromId);
        } else {
            afficherToast("Nouveau message reçu !");
            chargerContacts();
        }
    });

    socket.on('userTyping', (userId) => {
        if (currentChatUserId === userId) document.getElementById('typing-indicator').style.display = 'block';
    });
    socket.on('userStoppedTyping', (userId) => {
        if (currentChatUserId === userId) document.getElementById('typing-indicator').style.display = 'none';
    });

    socket.on('messageDeleted', (msgId) => {
        const el = document.getElementById(`msg-${msgId}`);
        if (el) el.remove();
    });

    socket.on('chatCleared', (parId) => {
        if (currentChatUserId === parId) {
            document.getElementById('messages-history').innerHTML = 
                `<div style="text-align:center; color:#888; font-size:12px; margin-top:20px;">L'interlocuteur a vidé l'historique de la conversation.</div>`;
        }
    });

    socket.on('ephemereToggled', ({ actif }) => {
        chatOptions.ephemere = actif;
        document.getElementById('toggle-ephemeral').checked = actif;
        afficherToast(`Mode éphémère ${actif ? 'activé' : 'désactivé'} par l'interlocuteur.`);
    });
}

function jouerSonMessage() {
    try {
        const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
        audio.volume = 0.3;
        audio.play();
    } catch(e){}
}

// ============================================================================
// 2. AUTHENTIFICATION
// ============================================================================
async function connecter() {
    const pseudo = document.getElementById('pseudo').value.trim();
    const password = document.getElementById('password').value.trim();
    if (!pseudo || !password) return afficherErreurAuth("Remplissez tous les champs.");

    try {
        const res = await fetch('/auth/connexion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pseudo, password })
        });
        const data = await res.json();
        if (res.ok) {
            token = data.token;
            localStorage.setItem('token', token);
            initSocket();
            await chargerProfil();
            naviguerVers('feed');
        } else {
            afficherErreurAuth(data.erreur);
        }
    } catch(e) { afficherErreurAuth("Erreur de connexion au serveur."); }
}

async function inscrire() {
    const pseudo = document.getElementById('pseudo').value.trim();
    const password = document.getElementById('password').value.trim();
    if (!pseudo || !password) return afficherErreurAuth("Remplissez tous les champs.");

    try {
        const res = await fetch('/auth/inscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pseudo, password })
        });
        const data = await res.json();
        if (res.ok) {
            afficherToast("Compte créé ! Connectez-vous.");
            connecter();
        } else {
            afficherErreurAuth(data.erreur);
        }
    } catch(e) { afficherErreurAuth("Erreur serveur."); }
}

function deconnecter() {
    localStorage.removeItem('token');
    token = null;
    if (socket) socket.disconnect();
    location.reload();
}

function afficherErreurAuth(msg) {
    document.getElementById('auth-message').textContent = msg;
}

// ============================================================================
// 3. NAVIGATION & UI
// ============================================================================
function afficherEcran(id) {
    document.getElementById('auth-screen').style.display = id === 'auth-screen' ? 'block' : 'none';
    document.getElementById('main-screen').style.display = id === 'main-screen' ? 'block' : 'none';
}

function naviguerVers(section) {
    afficherEcran('main-screen');
    
    // Masquer toutes les sections
    ['feed-section', 'profile-section', 'messages-section', 'notifications-section'].forEach(id => {
        document.getElementById(id).style.display = 'none';
    });

    // Retirer la classe active
    document.querySelectorAll('.menu-item, .mobile-nav-item').forEach(el => el.classList.remove('active'));

    // Activer la section cible
    if (section === 'feed') {
        document.getElementById('feed-section').style.display = 'block';
        document.getElementById('nav-feed')?.classList.add('active');
        document.getElementById('mob-nav-feed')?.classList.add('active');
        chargerFeed();
    } else if (section === 'profil') {
        document.getElementById('profile-section').style.display = 'block';
        document.getElementById('nav-profil')?.classList.add('active');
        document.getElementById('mob-nav-profil')?.classList.add('active');
        if (currentUser) chargerVueProfil(currentUser._id);
    } else if (section === 'messages') {
        document.getElementById('messages-section').style.display = 'block';
        document.getElementById('nav-messages')?.classList.add('active');
        document.getElementById('mob-nav-messages')?.classList.add('active');
        chargerContacts();
        chargerStatuts();
    } else if (section === 'notifications') {
        document.getElementById('notifications-section').style.display = 'block';
        document.getElementById('nav-notifications')?.classList.add('active');
        document.getElementById('mob-nav-notifications')?.classList.add('active');
        chargerNotifications();
    }
    window.scrollTo(0, 0);
}

function ouvrirRechercheMobile() { document.getElementById('mobile-search-overlay').style.display = 'flex'; }
function fermerRechercheMobile() { document.getElementById('mobile-search-overlay').style.display = 'none'; }

function fermerChatMobile() {
    document.getElementById('chat-window').classList.remove('active-mobile');
    currentChatUserId = null;
}

// ============================================================================
// 4. PROFIL UTILISATEUR & RECADRAGE PHOTO
// ============================================================================
async function chargerProfil() {
    try {
        const res = await fetch('/users/me', { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) {
            currentUser = await res.json();
            document.getElementById('sidebar-pseudo').textContent = `@${currentUser.pseudo}`;
            if (currentUser.avatarUrl) {
                document.getElementById('sidebar-avatar').src = currentUser.avatarUrl;
                document.getElementById('feed-creator-avatar').src = currentUser.avatarUrl;
                document.getElementById('my-status-avatar-img').src = currentUser.avatarUrl;
            }
        } else if (res.status === 401 || res.status === 403) {
            deconnecter();
        }
    } catch(e){}
}

async function chargerVueProfil(userId) {
    const res = await fetch(`/users/${userId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.redirectMe) return chargerVueProfil(currentUser._id);

    document.getElementById('profile-pseudo').textContent = `@${data.pseudo}`;
    document.getElementById('profile-avatar-img').src = data.avatarUrl || "https://www.w3schools.com/howto/img_avatar.png";
    document.getElementById('profile-stats').textContent = `${data.postsCount} publication(s)`;

    const actionContainer = document.getElementById('profile-action-container');
    const settingsContainer = document.getElementById('profile-settings-container');
    actionContainer.innerHTML = ''; settingsContainer.innerHTML = '';

    if (data._id === currentUser._id) {
        document.getElementById('change-avatar-label').style.display = 'flex';
        settingsContainer.innerHTML = `
            <div style="margin-top: 20px; display: flex; gap: 10px; justify-content: center;">
                <button class="btn-secondary" onclick="modifierPseudo()"><i class="fa-solid fa-pen"></i> Changer pseudo</button>
                <button class="btn-secondary" style="color:var(--danger); border-color:var(--danger);" onclick="supprimerCompte()"><i class="fa-solid fa-trash"></i> Supprimer compte</button>
            </div>`;
    } else {
        document.getElementById('change-avatar-label').style.display = 'none';
        const btn = document.createElement('button');
        btn.className = data.estAbonne ? 'btn-secondary' : 'btn-primary';
        btn.innerHTML = data.estAbonne ? '<i class="fa-solid fa-check"></i> Abonné' : '<i class="fa-solid fa-user-plus"></i> S\'abonner';
        btn.onclick = () => basculerAbonnement(data._id, data.estAbonne);
        actionContainer.appendChild(btn);
    }

    const postsContainer = document.getElementById('profile-posts-container');
    postsContainer.innerHTML = '';
    data.posts.forEach(p => postsContainer.appendChild(creerElementPost({ ...p, auteur: { pseudo: data.pseudo, avatarUrl: data.avatarUrl }, estLeMien: data._id === currentUser._id })));
}

function ouvrirRecadrageAvatar(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = document.getElementById('image-to-crop');
        img.src = e.target.result;
        document.getElementById('crop-modal').style.display = 'flex';
        if (cropper) cropper.destroy();
        cropper = new Cropper(img, { aspectRatio: 1, viewMode: 1 });
    };
    reader.readAsDataURL(file);
}

function fermerModaleRecadrage() {
    document.getElementById('crop-modal').style.display = 'none';
    if (cropper) cropper.destroy();
}

async function sauvegarderAvatarRecadre() {
    if (!cropper) return;
    cropper.getCroppedCanvas({ width: 300, height: 300 }).toBlob(async (blob) => {
        const formData = new FormData();
        formData.append('avatar', blob, 'avatar.jpg');
        const res = await fetch('/users/me/avatar', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        if (res.ok) {
            fermerModaleRecadrage();
            await chargerProfil();
            chargerVueProfil(currentUser._id);
            afficherToast("Photo de profil mise à jour !");
        }
    }, 'image/jpeg');
}

async function modifierPseudo() {
    const nouveau = prompt("Entrez votre nouveau pseudo :", currentUser.pseudo);
    if (!nouveau || !nouveau.trim()) return;
    const res = await fetch('/users/me/pseudo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ nouveauPseudo: nouveau })
    });
    const data = await res.json();
    if (res.ok) {
        afficherToast("Pseudo modifié !");
        await chargerProfil();
        chargerVueProfil(currentUser._id);
    } else { alert(data.erreur); }
}

async function supprimerCompte() {
    if (!confirm("Attention ! Supprimer votre compte est irréversible. Continuer ?")) return;
    const res = await fetch('/users/me', { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) deconnecter();
}

async function basculerAbonnement(userId, estAbonne) {
    const endpoint = estAbonne ? 'unfollow' : 'follow';
    const res = await fetch(`/users/${userId}/${endpoint}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
        chargerVueProfil(userId);
        afficherToast(estAbonne ? "Désabonné" : "Abonné !");
    }
}

// ============================================================================
// 5. FIL D'ACTUALITÉ & PUBLICATIONS
// ============================================================================
async function chargerFeed() {
    const res = await fetch('/feed', { headers: { 'Authorization': `Bearer ${token}` } });
    const posts = await res.json();
    const container = document.getElementById('feed-container');
    container.innerHTML = '';
    if (posts.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:#888; padding:40px 0;">Aucune publication pour le moment. Suivez des membres ou publiez !</div>`;
        return;
    }
    posts.forEach(p => container.appendChild(creerElementPost(p)));
}

function previsualiserImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    const container = document.getElementById('preview-container');
    const img = document.getElementById('image-preview');
    const vid = document.getElementById('video-preview');
    container.style.display = 'block'; img.style.display = 'none'; vid.style.display = 'none';

    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) { vid.src = url; vid.style.display = 'block'; }
    else { img.src = url; img.style.display = 'block'; }
}

function annulerImage() {
    document.getElementById('post-image').value = '';
    document.getElementById('preview-container').style.display = 'none';
}

async function publier() {
    const contenu = document.getElementById('post-content').value.trim();
    const file = document.getElementById('post-image').files[0];
    if (!contenu && !file) return afficherToast("Ajoutez du texte ou un média.");

    const formData = new FormData();
    formData.append('contenu', contenu);
    if (file) formData.append('image', file);

    const res = await fetch('/posts', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
    });
    if (res.ok) {
        document.getElementById('post-content').value = '';
        annulerImage();
        chargerFeed();
        afficherToast("Publication en ligne !");
    }
}

function creerElementPost(post) {
    const div = document.createElement('div');
    div.className = 'post-card';
    const estLike = post.likes.includes(currentUser?._id);

    let mediaHtml = '';
    if (post.imageUrl) {
        if (post.mediaType === 'video') mediaHtml = `<video src="${post.imageUrl}" controls class="post-media"></video>`;
        else mediaHtml = `<img src="${post.imageUrl}" class="post-media">`;
    }

    let commentsHtml = '';
    post.commentaires.forEach(c => {
        commentsHtml += `<div class="comment-item"><span class="comment-author">${c.auteur}:</span><span>${c.texte}</span></div>`;
    });

    div.innerHTML = `
        <div class="post-header">
            <div class="post-author" onclick="naviguerVers('profil'); chargerVueProfil('${post.auteurId}')" style="cursor:pointer;">
                <img src="${post.auteur?.avatarUrl || 'https://www.w3schools.com/howto/img_avatar.png'}" class="avatar-round-mini">
                <div>
                    <div>${post.auteur?.pseudo || 'Anonyme'}</div>
                    <span class="post-date">${formaterDate(post.date)}</span>
                </div>
            </div>
            ${post.estLeMien ? `<button class="btn-icon" onclick="supprimerPost('${post._id}')" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>` : ''}
        </div>
        <div class="post-body">${post.contenu}</div>
        ${mediaHtml}
        <div class="post-actions-bar">
            <button class="action-btn ${estLike ? 'liked' : ''}" onclick="likerPost('${post._id}')">
                <i class="fa-${estLike ? 'solid' : 'regular'} fa-heart"></i> ${post.likes.length}
            </button>
            <button class="action-btn" onclick="toggleCommentaires('${post._id}')">
                <i class="fa-regular fa-comment"></i> ${post.commentaires.length}
            </button>
        </div>
        <div id="comments-${post._id}" class="comments-section" style="display:none;">
            <div id="comments-list-${post._id}">${commentsHtml}</div>
            <div style="display:flex; gap:10px; margin-top:10px;">
                <input type="text" id="input-comment-${post._id}" placeholder="Votre commentaire..." style="margin-bottom:0; padding:8px 12px; font-size:12px;" onkeydown="if(event.key==='Enter') commenterPost('${post._id}')">
                <button class="btn-primary" style="padding:8px 12px; font-size:12px;" onclick="commenterPost('${post._id}')">Envoyer</button>
            </div>
        </div>
    `;
    return div;
}

async function likerPost(id) {
    await fetch(`/posts/${id}/like`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    chargerFeed();
}

function toggleCommentaires(id) {
    const el = document.getElementById(`comments-${id}`);
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function commenterPost(id) {
    const input = document.getElementById(`input-comment-${id}`);
    const texte = input.value.trim();
    if (!texte) return;
    await fetch(`/posts/${id}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ texte })
    });
    chargerFeed();
}

async function supprimerPost(id) {
    if (!confirm("Supprimer cette publication ?")) return;
    await fetch(`/posts/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    chargerFeed();
}

// ============================================================================
// 6. MESSAGERIE PRO & ENREGISTREMENT VOCAL
// ============================================================================
async function chargerContacts() {
    const res = await fetch('/messages/contacts', { headers: { 'Authorization': `Bearer ${token}` } });
    const contacts = await res.json();
    const container = document.getElementById('contacts-container');
    container.innerHTML = '';

    contacts.forEach(c => {
        const div = document.createElement('div');
        div.className = `contact-item ${currentChatUserId === c._id ? 'active' : ''}`;
        div.onclick = () => ouvrirDiscussion(c._id, c.pseudo, c.avatarUrl);
        div.innerHTML = `
            <img src="${c.avatarUrl || 'https://www.w3schools.com/howto/img_avatar.png'}" class="avatar-round-mini">
            <div class="contact-info">
                <span class="contact-name">${c.pseudo}</span>
                <span class="contact-last-msg">${c.dernierMessage || 'Nouvelle discussion'}</span>
            </div>
        `;
        container.appendChild(div);
    });
}

async function ouvrirDiscussion(userId, pseudo, avatarUrl) {
    currentChatUserId = userId;
    document.getElementById('chat-header-text').textContent = pseudo;
    document.getElementById('chat-header-status').style.display = 'block';
    document.getElementById('chat-input-block').style.display = 'flex';

    // UI Mobile responsive
    document.getElementById('chat-window').classList.add('active-mobile');

    // Mettre à jour la classe active sur la liste
    document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));

    const res = await fetch(`/messages/${userId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const msgs = await res.json();
    const history = document.getElementById('messages-history');
    history.innerHTML = '';
    msgs.forEach(m => ajouterMessageUI(m));
    history.scrollTop = history.scrollHeight;

    socket.emit('markAsRead', userId);
}

function ajouterMessageUI(m) {
    const history = document.getElementById('messages-history');
    const div = document.createElement('div');
    div.id = `msg-${m.id}`;
    const estMoi = m.fromId === currentUser._id;
    div.className = `message-bubble ${estMoi ? 'msg-sent' : 'msg-received'}`;
    if (estMoi) div.style.backgroundColor = chatOptions.couleur;

    let contenuHtml = '';
    if (m.mediaUrl) {
        if (m.mediaType === 'audio') contenuHtml = `<audio src="${m.mediaUrl}" controls style="max-width:200px; height:35px;"></audio>`;
        else contenuHtml = `<img src="${m.mediaUrl}" style="max-width:100%; border-radius:8px; margin-bottom:5px;">`;
    }
    if (m.texte) contenuHtml += `<div>${m.texte}</div>`;

    div.innerHTML = `
        ${estMoi ? `<button class="msg-delete-btn" onclick="supprimerMessageIndividuel('${m.id}')" title="Supprimer"><i class="fa-solid fa-xmark"></i></button>` : ''}
        ${contenuHtml}
        <span class="msg-time">${m.ephemere ? '⏱️ ' : ''}${new Date(m.date).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
    `;
    history.appendChild(div);
    history.scrollTop = history.scrollHeight;
}

async function envoyerMessage(mediaBlob = null, isAudio = false) {
    if (!currentChatUserId) return;
    const input = document.getElementById('message-text');
    const texte = input.value.trim();
    if (!texte && !mediaBlob) return;

    const formData = new FormData();
    if (texte) formData.append('texte', texte);
    formData.append('ephemere', chatOptions.ephemere);
    if (mediaBlob) formData.append('media', mediaBlob, isAudio ? 'vocal.webm' : 'image.jpg');

    input.value = '';
    const res = await fetch(`/messages/${currentChatUserId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
    });
    if (res.ok) {
        const m = await res.json();
        ajouterMessageUI(m);
        chargerContacts();
    }
}

async function supprimerMessageIndividuel(id) {
    const res = await fetch(`/messages/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
        const el = document.getElementById(`msg-${id}`);
        if (el) el.remove();
        afficherToast("Message supprimé.");
    }
}

async function viderHistoriqueChat() {
    if (!currentChatUserId || !confirm("Vider toute la conversation ?")) return;
    const res = await fetch(`/messages/clear/${currentChatUserId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
        document.getElementById('messages-history').innerHTML = '';
        toggleChatSettings();
        afficherToast("Conversation effacée.");
    }
}

// Gestion de l'enregistrement vocal (Appui long)
async function demarrerEnregistrementVocal(e) {
    e.preventDefault();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = (event) => audioChunks.push(event.data);
        mediaRecorder.start();

        document.getElementById('voice-recording-indicator').style.display = 'flex';
        document.getElementById('btn-hold-mic').classList.add('recording');
        recordingSeconds = 0;
        document.getElementById('recording-timer').textContent = "0:00";
        recordingInterval = setInterval(() => {
            recordingSeconds++;
            const m = Math.floor(recordingSeconds / 60);
            const s = (recordingSeconds % 60).toString().padStart(2, '0');
            document.getElementById('recording-timer').textContent = `${m}:${s}`;
        }, 1000);
    } catch(err) { afficherToast("Accès au microphone refusé."); }
}

function arreterEtEnvoyerVocal(e) {
    e.preventDefault();
    annulerUIEnregistrement();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            if (recordingSeconds >= 1) envoyerMessage(audioBlob, true);
            else afficherToast("Message vocal trop court.");
        };
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
}

function annulerEnregistrementVocal() {
    annulerUIEnregistrement();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
}

function annulerUIEnregistrement() {
    clearInterval(recordingInterval);
    document.getElementById('voice-recording-indicator').style.display = 'none';
    document.getElementById('btn-hold-mic').classList.remove('recording');
}

// ============================================================================
// 7. DRAWER DE PARAMÈTRES ET PERSONNALISATION DU CHAT
// ============================================================================
function toggleChatSettings() {
    const drawer = document.getElementById('chat-settings-drawer');
    drawer.classList.toggle('hidden');
}

function changerCouleurChat(couleur) {
    chatOptions.couleur = couleur;
    document.querySelectorAll('.msg-sent').forEach(el => el.style.backgroundColor = couleur);
}

function changerFondChat(theme) {
    chatOptions.fond = theme;
    const history = document.getElementById('messages-history');
    history.className = 'messages-history';
    if (theme !== 'default') history.classList.add(`bg-${theme}`);
}

function toggleEphemere(actif) {
    chatOptions.ephemere = actif;
    if (currentChatUserId && socket) {
        socket.emit('toggleEphemere', { cibleId: currentChatUserId, actif });
    }
    afficherToast(`Messages éphémères : ${actif ? 'ON' : 'OFF'}`);
}

function toggleMute(actif) {
    chatOptions.mute = actif;
    afficherToast(`Sons de discussion : ${actif ? 'Muet' : 'Actifs'}`);
}

// ============================================================================
// 8. STATUTS PRIVÉS 24H (STORIES)
// ============================================================================
async function chargerStatuts() {
    const res = await fetch('/statuses', { headers: { 'Authorization': `Bearer ${token}` } });
    const statuts = await res.json();
    const container = document.getElementById('contacts-statuses-container');
    container.innerHTML = '';

    const groupes = {};
    statuts.forEach(s => {
        if (!groupes[s.userId]) groupes[s.userId] = { author: s.author, avatarUrl: s.avatarUrl, items: [] };
        groupes[s.userId].items.push(s);
    });

    Object.keys(groupes).forEach(uId => {
        if (uId === currentUser._id) return;
        const g = groupes[uId];
        const nonLus = g.items.some(x => !x.read);
        const div = document.createElement('div');
        div.className = 'status-bubble';
        div.onclick = () => visionnerStatuts(g.items);
        div.innerHTML = `
            <div class="status-avatar-box" style="${!nonLus ? 'background: #555;' : ''}">
                <img src="${g.avatarUrl || 'https://www.w3schools.com/howto/img_avatar.png'}">
            </div>
            <span class="status-name">${g.author}</span>
        `;
        container.appendChild(div);
    });
}

function ouvrirModaleCreationStatut() { document.getElementById('create-status-modal').style.display = 'flex'; }
function fermerModaleCreationStatut() {
    document.getElementById('create-status-modal').style.display = 'none';
    document.getElementById('status-text-input').value = '';
    retirerMediaStatut();
}

function previsualiserMediaStatut(e) {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('status-media-preview-container').style.display = 'block';
    document.getElementById('status-image-preview').src = URL.createObjectURL(file);
}

function retirerMediaStatut() {
    document.getElementById('status-file-upload').value = '';
    document.getElementById('status-media-preview-container').style.display = 'none';
}

async function publierStatut() {
    const texte = document.getElementById('status-text-input').value.trim();
    const file = document.getElementById('status-file-upload').files[0];
    if (!texte && !file) return;

    const formData = new FormData();
    if (texte) formData.append('texte', texte);
    if (file) formData.append('statusMedia', file);

    const res = await fetch('/statuses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
    });
    if (res.ok) {
        fermerModaleCreationStatut();
        chargerStatuts();
        afficherToast("Statut diffusé !");
    }
}

let activeStories = [];
let currentStoryIdx = 0;
let storyTimer = null;

function visionnerStatuts(items) {
    activeStories = items;
    currentStoryIdx = 0;
    document.getElementById('view-status-modal').style.display = 'flex';
    afficherStoryEnCours();
}

function afficherStoryEnCours() {
    if (currentStoryIdx >= activeStories.length) return fermerVisionneuseStatut();
    const s = activeStories[currentStoryIdx];

    document.getElementById('viewer-author-name').textContent = s.author;
    document.getElementById('viewer-author-avatar').src = s.avatarUrl || 'https://www.w3schools.com/howto/img_avatar.png';
    document.getElementById('viewer-status-time').textContent = formaterDate(s.date);

    const body = document.getElementById('viewer-content-area');
    body.innerHTML = '';
    if (s.mediaUrl) body.innerHTML = `<img src="${s.mediaUrl}">`;
    else body.innerHTML = `<div style="padding:40px; font-weight:600;">${s.text}</div>`;

    fetch(`/statuses/${s._id}/read`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });

    const fill = document.getElementById('status-progress-bar');
    fill.style.transition = 'none'; fill.style.width = '0%';
    setTimeout(() => {
        fill.style.transition = 'width 5s linear';
        fill.style.width = '100%';
    }, 50);

    clearTimeout(storyTimer);
    storyTimer = setTimeout(() => {
        currentStoryIdx++;
        afficherStoryEnCours();
    }, 5000);
}

function fermerVisionneuseStatut() {
    clearTimeout(storyTimer);
    document.getElementById('view-status-modal').style.display = 'none';
    chargerStatuts();
}

// ============================================================================
// 9. RECHERCHE, NOTIFICATIONS & UTILITAIRES
// ============================================================================
async function rechercherUtilisateurs() {
    const q = document.getElementById('search-username').value.trim();
    if (!q) return;
    const res = await fetch(`/users/search?q=${encodeURIComponent(q)}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const us = await res.json();
    const resDiv = document.getElementById('search-results');
    resDiv.innerHTML = '';
    us.forEach(u => {
        const div = document.createElement('div');
        div.style = "padding:8px; font-size:13px; cursor:pointer; border-bottom:1px solid #333; display:flex; align-items:center; gap:8px;";
        div.innerHTML = `<img src="${u.avatarUrl || 'https://www.w3schools.com/howto/img_avatar.png'}" class="avatar-round-mini" style="width:25px;height:25px;"> @${u.pseudo}`;
        div.onclick = () => { naviguerVers('profil'); chargerVueProfil(u._id); };
        resDiv.appendChild(div);
    });
}

async function rechercherUtilisateursMobile() {
    const q = document.getElementById('mob-search-input').value.trim();
    const container = document.getElementById('mob-search-results-container');
    if (!q) { container.innerHTML = ''; return; }
    const res = await fetch(`/users/search?q=${encodeURIComponent(q)}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const us = await res.json();
    container.innerHTML = '';
    us.forEach(u => {
        const div = document.createElement('div');
        div.style = "padding:12px; font-size:14px; cursor:pointer; border-bottom:1px solid #333; display:flex; align-items:center; gap:10px;";
        div.innerHTML = `<img src="${u.avatarUrl || 'https://www.w3schools.com/howto/img_avatar.png'}" class="avatar-round-mini" style="width:30px;height:30px;"> @${u.pseudo}`;
        div.onclick = () => { fermerRechercheMobile(); naviguerVers('profil'); chargerVueProfil(u._id); };
        container.appendChild(div);
    });
}

async function chargerNotifications() {
    const res = await fetch('/notifications', { headers: { 'Authorization': `Bearer ${token}` } });
    const notifs = await res.json();
    const container = document.getElementById('notifications-container');
    container.innerHTML = '';
    if (notifs.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:#888; padding:40px;">Aucune notification.</div>`;
        return;
    }
    notifs.forEach(n => {
        const div = document.createElement('div');
        div.style = "padding:15px; background:var(--panel-dark); margin-bottom:10px; border-radius:8px; border:1px solid var(--border-color); font-size:13px;";
        div.innerHTML = `<strong>@${n.fromPseudo}</strong> ${n.type === 'like' ? 'a aimé votre publication ❤️' : 'a commenté votre publication 💬'} <span style="float:right; font-size:11px; color:#888;">${formaterDate(n.date)}</span>`;
        container.appendChild(div);
    });
    fetch('/notifications/read', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    actualiserBadgeNotifs(0);
}

function actualiserBadgeNotifs(count) {
    const b1 = document.getElementById('notif-badge');
    const b2 = document.getElementById('mob-notif-badge');
    const b3 = document.getElementById('top-mob-notif-badge');
    if (count > 0) {
        [b1, b2, b3].forEach(el => { if(el) { el.style.display = 'inline-block'; el.textContent = count; } });
    } else {
        [b1, b2, b3].forEach(el => { if(el) el.style.display = 'none'; });
    }
}

function afficherToast(msg) {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

function formaterDate(d) {
    const dt = new Date(d);
    const diff = Math.floor((new Date() - dt) / 60000);
    if (diff < 1) return "À l'instant";
    if (diff < 60) return `Il y a ${diff} min`;
    if (diff < 1440) return `Il y a ${Math.floor(diff/60)} h`;
    return dt.toLocaleDateString();
}