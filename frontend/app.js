const API_URL = window.location.origin;
const PAR_DEFAUT_AVATAR = "https://www.w3schools.com/howto/img_avatar.png";

let fichierImageSelectionne = null; 
let fichierStatutSelectionne = null;
let chatActifUserId = null; 
let cropperInstance = null;
let dernierIdNotification = null;
let intervalleDiscussionLive = null;
let memoireNombreMessages = 0;
let statusTimerInterval = null;

// Variables pour l'enregistrement vocal
let mediaRecorder = null;
let audioChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;

// --- REQUÊTES GENERALES AUX EN-TÊTES API ---
async function fetchAPI(endpoint, options = {}) {
    const token = localStorage.getItem("social_token");
    options.headers = {
        ...options.headers,
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };
    const res = await fetch(`${API_URL}${endpoint}`, options);
    if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("social_token");
        location.reload();
        return null;
    }
    return res;
}

// --- UTILITAIRES UX ---
function formaterDateRelative(dateISO) {
    if (!dateISO) return "";
    const diffSecondes = Math.floor((new Date() - new Date(dateISO)) / 1000);
    if (diffSecondes < 60) return "À l'instant";
    if (diffSecondes < 3600) return `Il y a ${Math.floor(diffSecondes / 60)} min`;
    if (diffSecondes < 86400) return `Il y a ${Math.floor(diffSecondes / 3600)} h`;
    return `Le ${new Date(dateISO).toLocaleDateString()}`;
}

function afficherToast(message) {
    let container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 400); 
    }, 3000);
}

window.onload = () => {
    const token = localStorage.getItem("social_token");
    if (token) {
        document.getElementById("auth-screen").style.display = "none";
        document.getElementById("main-screen").style.display = "block";
        mettreAjourAvatarsEtInfosEnCochiffre();
        naviguerVers('feed');
        actualiserBadgeNotifications(true);
        setInterval(() => { actualiserBadgeNotifications(false); }, 6000);
    }
};

// --- ROUTAGE INTERNE (SPA) ---
function naviguerVers(section, targetId = null) {
    if (section !== 'messages' && intervalleDiscussionLive) {
        clearInterval(intervalleDiscussionLive);
        intervalleDiscussionLive = null;
    }

    document.querySelectorAll('.menu-item, .mobile-nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('feed-section').style.display = "none";
    document.getElementById('profile-section').style.display = "none";
    document.getElementById('messages-section').style.display = "none";
    document.getElementById('notifications-section').style.display = "none";

    if (section === 'messages') {
        document.getElementById('mobile-messages-layout').classList.remove('chat-active');
        chatActifUserId = null;
    }

    const activeDesk = document.getElementById(`nav-${section}`);
    const activeMob = document.getElementById(`mob-nav-${section}`);
    if (activeDesk) activeDesk.classList.add('active');
    if (activeMob) activeMob.classList.add('active');

    if (section === 'feed') { document.getElementById('feed-section').style.display = "block"; chargerFeed(); }
    else if (section === 'profil') { document.getElementById('profile-section').style.display = "block"; chargerProfil(targetId); }
    else if (section === 'messages') { document.getElementById('messages-section').style.display = "block"; chargerMessagerie(targetId); }
    else if (section === 'notifications') { document.getElementById('notifications-section').style.display = "block"; chargerNotifications(); }
}

// --- AUTHENTIFICATION ---
async function inscrire() {
    const pseudo = document.getElementById("pseudo").value.trim();
    const password = document.getElementById("password").value.trim();
    if(!pseudo || !password) return afficherToast("Champs vides.");

    const res = await fetch(`${API_URL}/auth/inscription`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pseudo, password })
    });
    const data = await res.json();
    if (res.ok) {
        document.getElementById("auth-message").style.color = "green";
        document.getElementById("auth-message").innerText = "Inscription réussie ! Connectez-vous.";
    } else {
        document.getElementById("auth-message").style.color = "var(--danger)";
        document.getElementById("auth-message").innerText = data.erreur;
    }
}

async function connecter() {
    const pseudo = document.getElementById("pseudo").value.trim();
    const password = document.getElementById("password").value.trim();

    const res = await fetch(`${API_URL}/auth/connexion`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pseudo, password })
    });
    const data = await res.json();
    if (res.ok) {
        localStorage.setItem("social_token", data.token);
        location.reload();
    } else {
        document.getElementById("auth-message").style.color = "var(--danger)";
        document.getElementById("auth-message").innerText = data.erreur;
    }
}

function deconnecter() {
    localStorage.removeItem("social_token");
    location.reload();
}

// --- COMPTE & PROFILS ---
async function mettreAjourAvatarsEtInfosEnCochiffre() {
    const res = await fetchAPI("/users/me");
    if (res && res.ok) {
        const moi = await res.json();
        const av = moi.avatarUrl ? `${API_URL}${moi.avatarUrl}` : PAR_DEFAUT_AVATAR;
        document.getElementById("sidebar-avatar").src = av;
        document.getElementById("feed-creator-avatar").src = av;
        document.getElementById("my-status-avatar-img").src = av;
        document.getElementById("sidebar-pseudo").innerText = "@" + moi.pseudo;
    }
}

async function chargerProfil(userId = null) {
    const estMonProfil = !userId || userId === "me";
    const url = estMonProfil ? `/users/me` : `/users/${userId}`;
    const res = await fetchAPI(url);

    if (res && res.ok) {
        const data = await res.json();
        if (data.redirectMe) return chargerProfil("me");

        document.getElementById("profile-pseudo").innerText = "@" + data.pseudo;
        document.getElementById("profile-avatar-img").src = data.avatarUrl ? `${API_URL}${data.avatarUrl}` : PAR_DEFAUT_AVATAR;

        const labelModif = document.getElementById("change-avatar-label");
        const actionBox = document.getElementById("profile-action-container");
        const settingsBox = document.getElementById("profile-settings-container");
        const postsBox = document.getElementById("profile-posts-container");
        
        actionBox.innerHTML = ""; settingsBox.innerHTML = ""; postsBox.innerHTML = "";

        if (estMonProfil) {
            labelModif.style.display = "flex"; 
            document.getElementById("profile-stats").innerText = `Abonnements : ${data.abonnementsCount} | Publications : ${data.mesPosts.length}`;
            settingsBox.innerHTML = `
                <div style="margin-top:20px; border-top:1px solid var(--border-color); padding-top:15px;">
                    <div style="display:flex; justify-content:center; gap:10px; margin-bottom:15px;">
                        <input type="text" id="input-nouveau-pseudo" placeholder="Changer pseudo" style="width:auto;">
                        <button class="btn-secondary" onclick="modifierMonPseudo()">Modifier</button>
                    </div>
                    <button onclick="supprimerMonCompte()" style="background:var(--danger); color:white; padding:8px 12px; border-radius:4px;">Supprimer le compte</button>
                </div>`;
            if(data.mesPosts.length === 0) { postsBox.innerHTML = "<p style='color:var(--text-muted);'>Aucun post.</p>"; return; }
            data.mesPosts.forEach(p => postsBox.appendChild(creerElementPost({...p, auteur: { pseudo: data.pseudo, avatarUrl: data.avatarUrl }, estLeMien: true})));
        } else {
            labelModif.style.display = "none"; 
            document.getElementById("profile-stats").innerText = `Publications : ${data.postsCount}`;
            let btnF = data.estAbonne ? `<button class="btn-secondary" onclick="desuivreUtilisateur('${data._id}')">Ne plus suivre</button>` : `<button class="btn-primary" onclick="suivreUtilisateur('${data._id}')">Suivre</button>`;
            actionBox.innerHTML = `<div style="display:flex; justify-content:center; gap:10px;">${btnF}<button class="btn-primary" onclick="naviguerVers('messages', '${data._id}')"><i class="fa-solid fa-envelope"></i> Message</button></div>`;

            if(data.posts.length === 0) { postsBox.innerHTML = "<p style='color:var(--text-muted);'>Aucun post.</p>"; return; }
            data.posts.forEach(p => postsBox.appendChild(creerElementPost({...p, auteur: { pseudo: data.pseudo, avatarUrl: data.avatarUrl }, estLeMien: false})));
        }
    }
}

function ouvrirRecadrageAvatar(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const imageElement = document.getElementById("image-to-crop");
        imageElement.src = e.target.result;
        document.getElementById("crop-modal").style.display = "flex";
        if (cropperInstance) cropperInstance.destroy();
        cropperInstance = new Cropper(imageElement, { aspectRatio: 1, viewMode: 1, background: false });
    };
    reader.readAsDataURL(file);
}

function fermerModaleRecadrage() {
    document.getElementById("crop-modal").style.display = "none";
    document.getElementById("avatar-file-input").value = "";
    if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
}

function sauvegarderAvatarRecadre() {
    if (!cropperInstance) return;
    cropperInstance.getCroppedCanvas({ width: 200, height: 200 }).toBlob(async (blob) => {
        const formData = new FormData();
        formData.append("avatar", blob, "avatar.jpg");
        const res = await fetchAPI("/users/me/avatar", { method: "POST", body: formData });
        if (res && res.ok) {
            afficherToast("Photo mise à jour !");
            fermerModaleRecadrage();
            mettreAjourAvatarsEtInfosEnCochiffre();
            chargerProfil("me"); 
        }
    }, "image/jpeg");
}

async function modifierMonPseudo() {
    const nouveauPseudo = document.getElementById('input-nouveau-pseudo').value.trim();
    if (!nouveauPseudo) return;
    const res = await fetchAPI("/users/me/pseudo", {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nouveauPseudo })
    });
    if (res && res.ok) {
        afficherToast("Pseudo modifié !");
        mettreAjourAvatarsEtInfosEnCochiffre();
        chargerProfil("me"); 
    }
}

async function supprimerMonCompte() {
    if (!confirm("Supprimer définitivement votre compte ?")) return;
    const res = await fetchAPI("/users/me", { method: 'DELETE' });
    if (res && res.ok) deconnecter();
}

// --- SYSTEM DE POSTS & FIL D'ACTUALITÉ ---
function previsualiserImage(event) {
    const fichier = event.target.files[0];
    if (fichier) {
        fichierImageSelectionne = fichier;
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById("preview-container").style.display = "block";
            if (fichier.type.startsWith("video/")) {
                document.getElementById("image-preview").style.display = "none";
                document.getElementById("video-preview").src = e.target.result;
                document.getElementById("video-preview").style.display = "block";
            } else {
                document.getElementById("video-preview").style.display = "none";
                document.getElementById("image-preview").src = e.target.result;
                document.getElementById("image-preview").style.display = "block";
            }
        }
        reader.readAsDataURL(fichier);
    }
}

function annulerImage() {
    fichierImageSelectionne = null;
    document.getElementById("post-image").value = "";
    document.getElementById("preview-container").style.display = "none";
}

async function publier() {
    const contenu = document.getElementById("post-content").value;
    if (!contenu.trim() && !fichierImageSelectionne) return;

    const formData = new FormData();
    formData.append("contenu", contenu);
    if (fichierImageSelectionne) formData.append("image", fichierImageSelectionne);

    const res = await fetchAPI("/posts", { method: "POST", body: formData });
    if (res && res.ok) {
        document.getElementById("post-content").value = ""; 
        annulerImage();
        afficherToast("Post partagé !");
        chargerFeed();
    }
}

async function chargerFeed() {
    const res = await fetchAPI("/feed");
    if (!res || !res.ok) return;
    const posts = await res.json();
    const container = document.getElementById("feed-container");
    container.innerHTML = posts.length === 0 ? "<p style='color:var(--text-muted);'>Aucun post récent.</p>" : "";
    posts.forEach(p => container.appendChild(creerElementPost(p)));
}

function creerElementPost(post) {
    const div = document.createElement("div");
    div.className = "post";
    const nom = post.auteur ? post.auteur.pseudo : "Inconnu";
    const av = (post.auteur && post.auteur.avatarUrl) ? `${API_URL}${post.auteur.avatarUrl}` : PAR_DEFAUT_AVATAR;
    
    let media = "";
    if (post.imageUrl) {
        media = (post.mediaType === 'video' || post.imageUrl.endsWith('.mp4')) 
            ? `<video src="${API_URL}${post.imageUrl}" class="post-video" controls></video>`
            : `<img src="${API_URL}${post.imageUrl}" class="post-img">`;
    }

    let cmts = "";
    if (post.commentaires) {
        post.commentaires.forEach(c => {
            cmts += `<div class="comment"><strong>@${c.auteur}</strong> : ${c.texte}</div>`;
        });
    }

    let btnSuppr = post.estLeMien ? `<button class="btn-action" style="color:var(--danger);" onclick="supprimerPost('${post._id}')"><i class="fa-solid fa-trash"></i></button>` : "";
    
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
            <div onclick="naviguerVers('profil', '${post.auteurId}')" style="cursor:pointer; display:inline-flex; align-items:center; gap:8px;">
                <img src="${av}" class="avatar-round-mini">
                <span style="font-weight:600;">@${nom}</span>
            </div>
            ${btnSuppr}
        </div>
        <div class="post-content" style="margin-top:10px;">${post.contenu}</div>
        ${media}
        <div class="post-actions-bar">
            <button class="btn-action" onclick="liker('${post._id}')"><i class="fa-solid fa-heart" style="color:${post.likes.length > 0 ? 'var(--danger)':''}"></i> ${post.likes.length}</button>
        </div>
        <div class="comments-section">
            <div>${cmts}</div>
            <div class="add-comment">
                <input type="text" id="input-comment-${post._id}" placeholder="Ajouter un commentaire...">
                <button class="btn-action" onclick="ajouterCommentaire('${post._id}')">Envoyer</button>
            </div>
        </div>`;
    return div;
}

async function liker(postId) {
    const res = await fetchAPI(`/posts/${postId}/like`, { method: "POST" });
    if (res && res.ok) { if(document.getElementById('feed-section').style.display === 'block') chargerFeed(); else chargerProfil(); }
}

async function ajouterCommentaire(postId) {
    const input = document.getElementById(`input-comment-${postId}`);
    if (!input.value.trim()) return;
    const res = await fetchAPI(`/posts/${postId}/comment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texte: input.value })
    });
    if (res && res.ok) { input.value = ""; chargerFeed(); }
}

async function supprimerPost(postId) {
    if (confirm("Supprimer ce post ?")) { await fetchAPI(`/posts/${postId}`, { method: "DELETE" }); chargerFeed(); }
}

// --- RECHERCHE ET CONTACTS ---
async function rechercherUtilisateurs() {
    const q = document.getElementById("search-username").value.trim();
    if (!q) return;
    const res = await fetchAPI(`/users/search?q=${q}`);
    const users = await res.json();
    const container = document.getElementById("search-results");
    container.innerHTML = users.length === 0 ? "<p style='color:gray; font-size:12px;'>Aucun résultat.</p>" : "";
    
    users.forEach(u => {
        const div = document.createElement("div");
        div.className = "user-result";
        div.innerHTML = `<span>@${u.pseudo}</span><button class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="suivreUtilisateur('${u._id}')">Suivre</button>`;
        container.appendChild(div);
    });
}

async function suivreUtilisateur(userId) {
    const res = await fetchAPI(`/users/${userId}/follow`, { method: "POST" });
    if(res && res.ok) { afficherToast("Abonnement activé !"); chargerProfil(userId); }
}

async function desuivreUtilisateur(userId) {
    const res = await fetchAPI(`/users/${userId}/unfollow`, { method: "POST" });
    if(res && res.ok) { afficherToast("Abonnement retiré."); chargerProfil(userId); }
}

// --- MESSAGERIE EXCELLENCE UNIFIÉE ET LIVE POLLING ---
async function chargerMessagerie(forceUserChatId = null) {
    chargerStatuts(); 
    const res = await fetchAPI("/messages/contacts");
    if (res && res.ok) {
        const contacts = await res.json();
        const container = document.getElementById("contacts-container");
        container.innerHTML = "";

        contacts.forEach(c => {
            const av = c.avatarUrl ? `${API_URL}${c.avatarUrl}` : PAR_DEFAUT_AVATAR;
            let snip = c.dernierMessage ? (c.dernierMessage.length > 20 ? c.dernierMessage.substring(0,20)+"..." : c.dernierMessage) : "<span class='snippet-vide'>Nouvelle discussion</span>";
            
            const div = document.createElement("div");
            div.className = "contact-item";
            div.id = `contact-${c._id}`;
            div.innerHTML = `
                <img src="${av}" class="avatar-round-mini" style="width:38px; height:38px; flex-shrink:0;">
                <div class="contact-item-meta">
                    <span class="contact-pseudo">@${c.pseudo}</span>
                    <span class="contact-snippet">${snip}</span>
                </div>`;
            div.onclick = () => chargerDiscussion(c._id, true);
            container.appendChild(div);
        });
        if (forceUserChatId) chargerDiscussion(forceUserChatId, true);
    }
}

async function chargerDiscussion(userId, forcerScroll = false) {
    chatActifUserId = userId;
    const res = await fetchAPI(`/messages/${userId}`);
    if (res && res.ok) {
        const msgs = await res.json();
        const container = document.getElementById("messages-history");
        
        document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
        const activeItem = document.getElementById(`contact-${userId}`);
        if (activeItem) {
            activeItem.classList.add('active');
            document.getElementById("chat-header-text").innerText = activeItem.querySelector('.contact-pseudo').innerText;
        }

        if (msgs.length !== memoireNombreMessages || forcerScroll) {
            container.innerHTML = "";
            msgs.forEach(m => {
                const heure = new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const estMonMessage = m.fromId !== userId;
                let checks = "";
                
                // Indicateurs de lecture : double coche bleue (Lu) ou grise (Distribué)
                if (estMonMessage) {
                    if (m.status === 'read') {
                        checks = `<span style="color: #34b7f1; font-size: 11px; margin-left: 5px;"><i class="fa-solid fa-check-double"></i></span>`;
                    } else {
                        checks = `<span style="color: #999; font-size: 11px; margin-left: 5px;"><i class="fa-solid fa-check-double"></i></span>`;
                    }
                }

                let contenu = m.texte;
                if (m.mediaType === 'audio') {
                    contenu = `<audio src="${API_URL}${m.mediaUrl}" controls style="height: 35px; width: 220px; outline: none;"></audio>`;
                } else if (m.mediaUrl) {
                    contenu = `<img src="${API_URL}${m.mediaUrl}" style="max-width: 200px; border-radius: 8px;"><br>${m.texte || ""}`;
                }

                const div = document.createElement("div");
                div.className = `message-bubble ${estMonMessage ? 'sent' : 'received'}`;
                div.innerHTML = `${contenu} <span class="msg-timestamp" style="display:inline-block; font-size:10px; opacity:0.8; margin-top:5px;">${heure} ${checks}</span>`;
                container.appendChild(div);
            });
            memoireNombreMessages = msgs.length;
            if (forcerScroll) container.scrollTop = container.scrollHeight;
        }

        document.getElementById("chat-input-block").style.display = "flex";
        document.getElementById("mobile-messages-layout").classList.add("chat-active");

        if (intervalleDiscussionLive) clearInterval(intervalleDiscussionLive);
        intervalleDiscussionLive = setInterval(() => {
            if (chatActifUserId === userId && document.getElementById('messages-section').style.display === 'block') {
                chargerDiscussion(userId, false);
            }
        }, 2500);
    }
}

async function envoyerMessage() {
    const input = document.getElementById("message-text");
    if (!input.value.trim() || !chatActifUserId) return;
    const res = await fetchAPI(`/messages/${chatActifUserId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texte: input.value })
    });
    if (res && res.ok) { input.value = ""; chargerDiscussion(chatActifUserId, true); chargerMessagerie(); }
}

function fermerChatMobile() {
    chatActifUserId = null;
    if (intervalleDiscussionLive) clearInterval(intervalleDiscussionLive);
    document.getElementById("mobile-messages-layout").classList.remove("chat-active");
}

// --- LOGIQUE VOCALE (MICROPHONE) ---
async function demarrerEnregistrementVocal(e) {
    if (e && e.cancelable) e.preventDefault();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.start();
        document.getElementById("voice-recording-indicator").style.display = "flex";
        document.getElementById("message-text").style.display = "none";
        document.getElementById("btn-send-text").style.display = "none";
        
        recordingSeconds = 0;
        document.getElementById("recording-timer").innerText = "0:00";
        recordingTimer = setInterval(() => {
            recordingSeconds++;
            const mins = Math.floor(recordingSeconds / 60);
            const secs = recordingSeconds % 60;
            document.getElementById("recording-timer").innerText = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }, 1000);
    } catch (err) {
        afficherToast("Accès au microphone refusé.");
    }
}

function arreterEtEnvoyerVocal(e) {
    if (e && e.cancelable) e.preventDefault();
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.onstop = async () => {
            fermerIndicateurVocal();
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            if (audioBlob.size > 0 && chatActifUserId) {
                const formData = new FormData();
                formData.append("media", audioBlob, "vocal.webm");
                const res = await fetchAPI(`/messages/${chatActifUserId}`, {
                    method: "POST", body: formData
                });
                if (res && res.ok) {
                    chargerDiscussion(chatActifUserId, true);
                    chargerMessagerie();
                }
            }
            mediaRecorder.stream.getTracks().forEach(track => track.stop());
        };
        mediaRecorder.stop();
    }
    clearInterval(recordingTimer);
}

function annulerEnregistrementVocal() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        fermerIndicateurVocal();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    clearInterval(recordingTimer);
}

function fermerIndicateurVocal() {
    document.getElementById("voice-recording-indicator").style.display = "none";
    document.getElementById("message-text").style.display = "block";
    document.getElementById("btn-send-text").style.display = "block";
}

// --- NOTIFICATIONS ---
async function actualiserBadgeNotifications(silencieux) {
    const res = await fetchAPI("/notifications");
    if (res && res.ok) {
        const notifs = await res.json();
        const nonLues = notifs.filter(n => !n.read);
        const b1 = document.getElementById("notif-badge");
        const b2 = document.getElementById("mob-notif-badge");
        const b3 = document.getElementById("top-mob-notif-badge"); 

        if (nonLues.length > 0) {
            if(b1) { b1.innerText = nonLues.length; b1.style.display = "inline-block"; }
            if(b2) { b2.innerText = nonLues.length; b2.style.display = "inline-block"; }
            if(b3) { b3.innerText = nonLues.length; b3.style.display = "inline-block"; }

            if (!silencieux && notifs.length > 0 && notifs[0]._id !== dernierIdNotification) {
                dernierIdNotification = notifs[0]._id;
                afficherToast(`🔔 Nouvelle notification en attente !`);
                if(b1) b1.classList.add("badge-bounce"); 
                if(b2) b2.classList.add("badge-bounce");
                if(b3) b3.classList.add("badge-bounce");
            }
        } else { 
            if(b1) b1.style.display = "none"; 
            if(b2) b2.style.display = "none"; 
            if(b3) b3.style.display = "none"; 
        }
    }
}

async function chargerNotifications() {
    const res = await fetchAPI("/notifications");
    if (res && res.ok) {
        const notifs = await res.json();
        const container = document.getElementById("notifications-container");
        container.innerHTML = notifs.length === 0 ? "<p>Aucune alerte.</p>" : "";
        notifs.forEach(n => {
            const div = document.createElement("div");
            div.className = `notif-item ${!n.read ? 'unread':''}`;
            div.innerHTML = `<p><i class="fa-solid fa-bell" style="color:var(--gold);"></i> <strong>@${n.fromPseudo}</strong> a réagi à votre activité. <span style="font-size:11px; color:gray;">${formaterDateRelative(n.date)}</span></p>`;
            container.appendChild(div);
        });
        await fetchAPI("/notifications/read", { method: "POST" });
        
        ["notif-badge", "mob-notif-badge", "top-mob-notif-badge"].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.style.display = "none";
        });
    }
}

// --- LOGIQUE DES STORIES / STATUTS PRIVÉS ---
async function chargerStatuts() {
    const res = await fetchAPI("/statuses");
    if (!res || !res.ok) return;
    const statuts = await res.json();
    const listContainer = document.getElementById("contacts-statuses-container");
    listContainer.innerHTML = "";

    let mapMembres = {};
    statuts.forEach(s => {
        if (!mapMembres[s.userId]) {
            mapMembres[s.userId] = { pseudo: s.author, avatar: s.avatarUrl, list: [] };
        }
        mapMembres[s.userId].list.push(s);
    });

    Object.keys(mapMembres).forEach(uId => {
        const m = mapMembres[uId];
        const aLuTout = m.list.every(s => s.read);
        const av = m.avatar ? `${API_URL}${m.avatar}` : PAR_DEFAUT_AVATAR;

        const div = document.createElement("div");
        div.className = `status-bubble ${aLuTout ? '' : 'unread'}`;
        div.innerHTML = `
            <div class="status-avatar-box">
                <img src="${av}">
            </div>
            <span class="status-name">@${m.pseudo}</span>`;
        div.onclick = () => demarrerVisionneuseStatut(m.list);
        listContainer.appendChild(div);
    });
}

function ouvrirModaleCreationStatut() { document.getElementById('create-status-modal').style.display = 'flex'; }
function fermerModaleCreationStatut() { 
    document.getElementById('create-status-modal').style.display = 'none'; 
    document.getElementById('status-text-input').value = "";
    retirerMediaStatut();
}

function previsualiserMediaStatut(event) {
    const file = event.target.files[0];
    if (file) {
        fichierStatutSelectionne = file;
        document.getElementById('status-image-preview').src = URL.createObjectURL(file);
        document.getElementById('status-media-preview-container').style.display = 'block';
    }
}

function retirerMediaStatut() {
    fichierStatutSelectionne = null;
    document.getElementById('status-file-upload').value = "";
    document.getElementById('status-media-preview-container').style.display = 'none';
}

async function publierStatut() {
    const txt = document.getElementById('status-text-input').value;
    if (!txt.trim() && !fichierStatutSelectionne) return;

    const formData = new FormData();
    formData.append("texte", txt);
    if (fichierStatutSelectionne) formData.append("statusMedia", fichierStatutSelectionne);

    const res = await fetchAPI("/statuses", { method: "POST", body: formData });
    if (res && res.ok) { afficherToast("Statut partagé !"); fermerModaleCreationStatut(); chargerStatuts(); }
}

function demarrerVisionneuseStatut(statusArray) {
    let index = 0;
    const modal = document.getElementById('view-status-modal');
    modal.style.display = 'flex';

    async function afficherIndex() {
        if (index >= statusArray.length) { fermerVisionneuseStatut(); return; }
        const s = statusArray[index];
        
        await fetchAPI(`/statuses/${s._id}/read`, { method: "POST" });

        document.getElementById('viewer-author-name').innerText = `@${s.author}`;
        document.getElementById('viewer-author-avatar').src = s.avatarUrl ? `${API_URL}${s.avatarUrl}` : PAR_DEFAUT_AVATAR;
        document.getElementById('viewer-status-time').innerText = formaterDateRelative(s.date);

        const body = document.getElementById('viewer-content-area');
        if (s.type === 'image') {
            body.innerHTML = `<div style='text-align:center;'><img src="${API_URL}${s.mediaUrl}"><p style='color:white; margin-top:10px; font-size:14px;'>${s.text}</p></div>`;
        } else {
            body.innerHTML = `<div class="big-text-status">"${s.text}"</div>`;
        }

        const fillBar = document.getElementById('status-progress-bar');
        fillBar.style.transition = 'none'; fillBar.style.width = '0%';
        setTimeout(() => { fillBar.style.transition = 'width 5000ms linear'; fillBar.style.width = '100%'; }, 50);

        clearInterval(statusTimerInterval);
        statusTimerInterval = setTimeout(() => { index++; afficherIndex(); }, 5000);
    }
    afficherIndex();
}

function fermerVisionneuseStatut() {
    clearInterval(statusTimerInterval);
    document.getElementById('view-status-modal').style.display = 'none';
    chargerStatuts();
}

// --- GESTION DE LA RECHERCHE MOBILE ---
function ouvrirRechercheMobile() {
    document.getElementById("mobile-search-overlay").style.display = "flex";
    document.getElementById("mob-search-input").focus();
}

function fermerRechercheMobile() {
    document.getElementById("mobile-search-overlay").style.display = "none";
    document.getElementById("mob-search-input").value = "";
    document.getElementById("mob-search-results-container").innerHTML = "";
}

async function rechercherUtilisateursMobile() {
    const query = document.getElementById("mob-search-input").value.trim();
    const container = document.getElementById("mob-search-results-container");
    if (!query) { container.innerHTML = ""; return; }

    const res = await fetchAPI(`/users/search?q=${query}`);
    if (res && res.ok) {
        const users = await res.json();
        container.innerHTML = users.length === 0 ? "<p style='color:gray; font-size:12px;'>Aucun membre trouvé.</p>" : "";
        users.forEach(u => {
            container.innerHTML += `
                <div class="user-result" style="margin-bottom: 8px;">
                    <span>@${u.pseudo}</span>
                    <button class="btn-primary" style="padding: 4px 10px; font-size: 11px;" onclick="suivreUtilisateur('${u._id}'); fermerRechercheMobile();">Suivre</button>
                </div>`;
        });
    }
}