const API_URL = window.location.origin;
const PAR_DEFAUT_AVATAR = "https://www.w3schools.com/howto/img_avatar.png";

let fichierImageSelectionne = null; 
let fichierStatutSelectionne = null;

// Variables Chat & Conversations
let chatActifConvId = null; 
let chatActifDestinataireId = null;

let cropperInstance = null;
let dernierIdNotification = null;
let memoireDiscussionState = ""; 
let statusTimerInterval = null;

// Variables hardware d'enregistrement vocal
let mediaRecorder = null;
let audioChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;

// Variables WebSockets
let socket = null;
let typingTimeout = null;

// --- REQUÊTES GÉNÉRALES AUX EN-TÊTES API ---
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

// --- INITIALISATION AU CHARGEMENT DE LA PAGE ---
window.onload = () => {
    const token = localStorage.getItem("social_token");
    if (token) {
        document.getElementById("auth-screen").style.display = "none";
        document.getElementById("main-screen").style.display = "block";
        mettreAjourAvatarsEtInfosEnCochiffre();
        naviguerVers('feed');
        actualiserBadgeNotifications(true);
        
        // Initialisation WebSockets
        initialiserWebSockets(token);

        const inputMessage = document.getElementById("message-text");
        if(inputMessage) {
            inputMessage.addEventListener('input', gererIndicateurDeFrappe);
        }
    }
};

document.addEventListener("DOMContentLoaded", () => {
    initialiserReelsObserver();
    initialiserDoubleTapReels();
    initialiserFiltresMessagerie();
    initialiserRechercheMessagerie();
});

// ============================================================================
// MOTEUR WEBSOCKETS (ZÉRO LATENCE)
// ============================================================================
function initialiserWebSockets(token) {
    if (typeof io === "undefined") return;
    socket = io(API_URL, { auth: { token } });

    socket.on('newMessage', (msg) => {
        if (chatActifConvId === msg.conversationId && document.getElementById('messages-section').style.display === 'block') {
            chargerDiscussion(chatActifConvId, msg.fromId, null, true);
        } else {
            chargerMessagerie();
            actualiserBadgeNotifications(false);
            afficherToast("Nouveau message reçu !");
        }
    });

    socket.on('userTyping', (data) => {
        if (chatActifConvId === data.conversationId) {
            const ind = document.getElementById('typing-indicator');
            if(ind) {
                ind.style.display = 'block';
                ind.innerText = `@${data.pseudo} ${data.action}`;
            }
            const hist = document.getElementById("messages-history");
            if (hist) hist.scrollTop = hist.scrollHeight;
        }
    });

    socket.on('userStoppedTyping', (data) => {
        if (chatActifConvId === data.conversationId) {
            const ind = document.getElementById('typing-indicator');
            if(ind) ind.style.display = 'none';
        }
    });

    socket.on('messagesRead', (data) => {
        if (chatActifConvId === data.conversationId) {
            chargerDiscussion(chatActifConvId, chatActifDestinataireId, null, false); 
        }
    });

    // Rendre la suppression de message dynamique
    socket.on('messageDeleted', (data) => {
        if (chatActifConvId === data.conversationId) {
            chargerDiscussion(chatActifConvId, chatActifDestinataireId, null, false);
        }
    });

    // Synchroniser en direct le basculement du mode éphémère
    socket.on('ephemereToggled', (data) => {
        if (chatActifConvId === data.conversationId) {
            localStorage.setItem(`chat_ephemere_${chatActifConvId}`, data.actif);
            const check = document.getElementById('toggle-ephemeral');
            if (check) check.checked = data.actif;
            afficherToast(data.actif ? "⏱️ Le mode éphémère a été activé" : "⏱️ Messages éphémères désactivés");
        }
    });
}

function gererIndicateurDeFrappe() {
    if (!chatActifConvId || !socket) return;
    socket.emit('typing', { conversationId: chatActifConvId, isAudio: false });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stopTyping', chatActifConvId);
    }, 1500); 
}

// ============================================================================
// LOGIQUE DE NAVIGATION ET DE VUES
// ============================================================================
function naviguerVers(section, targetId = null) {
    document.querySelectorAll('.menu-item, .mobile-nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('feed-section').style.display = "none";
    document.getElementById('profile-section').style.display = "none";
    document.getElementById('messages-section').style.display = "none";
    document.getElementById('notifications-section').style.display = "none";

    if (section === 'messages') {
        const layout = document.getElementById('mobile-messages-layout');
        if(layout) layout.classList.remove('chat-active');
        chatActifConvId = null;
        chatActifDestinataireId = null;
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
        document.getElementById("auth-message").innerText = data.erreur || "Erreur lors de l'inscription.";
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
        document.getElementById("auth-message").innerText = data.erreur || "Connexion échouée.";
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
        const sidebarAv = document.getElementById("sidebar-avatar");
        const feedAv = document.getElementById("feed-creator-avatar");
        const statusAv = document.getElementById("my-status-avatar-img");
        if(sidebarAv) sidebarAv.src = av;
        if(feedAv) feedAv.src = av;
        if(statusAv) statusAv.src = av;
        const sidebarPseudo = document.getElementById("sidebar-pseudo");
        if(sidebarPseudo) sidebarPseudo.innerText = "@" + moi.pseudo;
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
            if(labelModif) labelModif.style.display = "flex"; 
            document.getElementById("profile-stats").innerText = `Abonnements : ${data.abonnementsCount || 0} | Publications : ${data.mesPosts ? data.mesPosts.length : 0}`;
            settingsBox.innerHTML = `
                <div style="margin-top:20px; border-top:1px solid var(--border-color); padding-top:15px;">
                    <div style="display:flex; justify-content:center; gap:10px; margin-bottom:15px;">
                        <input type="text" id="input-nouveau-pseudo" placeholder="Changer pseudo" style="width:auto;">
                        <button class="btn-secondary" onclick="modifierMonPseudo()">Modifier</button>
                    </div>
                    <button onclick="supprimerMonCompte()" style="background:var(--danger); color:white; padding:8px 12px; border-radius:4px; border:none; cursor:pointer;">Supprimer le compte</button>
                </div>`;
            if(!data.mesPosts || data.mesPosts.length === 0) { postsBox.innerHTML = "<p style='color:var(--text-muted);'>Aucun post.</p>"; return; }
            data.mesPosts.forEach(p => postsBox.appendChild(creerElementPost({...p, auteur: { pseudo: data.pseudo, avatarUrl: data.avatarUrl }, estLeMien: true})));
        } else {
            if(labelModif) labelModif.style.display = "none"; 
            document.getElementById("profile-stats").innerText = `Publications : ${data.postsCount || (data.posts ? data.posts.length : 0)}`;
            let btnF = data.estAbonne ? `<button class="btn-secondary" onclick="desuivreUtilisateur('${data._id}')">Ne plus suivre</button>` : `<button class="btn-primary" onclick="suivreUtilisateur('${data._id}')">Suivre</button>`;
            actionBox.innerHTML = `<div style="display:flex; justify-content:center; gap:10px;">${btnF}<button class="btn-primary" onclick="naviguerVers('messages', '${data._id}')"><i class="fa-solid fa-envelope"></i> Message</button></div>`;

            if(!data.posts || data.posts.length === 0) { postsBox.innerHTML = "<p style='color:var(--text-muted);'>Aucun post.</p>"; return; }
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
        if (typeof Cropper !== "undefined") {
            cropperInstance = new Cropper(imageElement, { aspectRatio: 1, viewMode: 1, background: false });
        }
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
        document.getElementById('input-nouveau-pseudo').value = '';
        mettreAjourAvatarsEtInfosEnCochiffre();
        chargerProfil("me"); 
    } else {
        const err = await res.json();
        afficherToast(err.erreur || "Erreur de modification");
    }
}

async function supprimerMonCompte() {
    if (!confirm("Supprimer définitivement votre compte et toutes vos données ?")) return;
    const res = await fetchAPI("/users/me", { method: 'DELETE' });
    if (res && res.ok) deconnecter();
}

// --- SYSTÈME DE POSTS & FIL D'ACTUALITÉ ---
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
        };
        reader.readAsDataURL(fichier);
    }
}

function annulerImage() {
    fichierImageSelectionne = null;
    const inputImg = document.getElementById("post-image");
    if (inputImg) inputImg.value = "";
    const preview = document.getElementById("preview-container");
    if (preview) preview.style.display = "none";
}

async function publier() {
    const inputContent = document.getElementById("post-content");
    const contenu = inputContent ? inputContent.value : "";
    if (!contenu.trim() && !fichierImageSelectionne) return;

    const formData = new FormData();
    formData.append("contenu", contenu);
    if (fichierImageSelectionne) formData.append("image", fichierImageSelectionne);

    const res = await fetchAPI("/posts", { method: "POST", body: formData });
    if (res && res.ok) {
        if(inputContent) inputContent.value = ""; 
        annulerImage();
        afficherToast("Post partagé !");
        chargerFeed();
    }
}

async function chargerFeed() {
    const res = await fetchAPI("/feed");
    if (!res || !res.ok) return;
    
    const data = await res.json();
    const posts = data.posts || data || []; 
    
    const container = document.getElementById("feed-container");
    if(!container) return;
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
            cmts += `<div class="comment"><strong>@${c.auteurPseudo || c.auteur}</strong> : ${c.texte}</div>`;
        });
    }

    let btnSuppr = post.estLeMien ? `<button class="btn-action" style="color:var(--danger);" onclick="supprimerPost('${post._id}')"><i class="fa-solid fa-trash"></i></button>` : "";
    
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <div onclick="naviguerVers('profil', '${post.auteurId}')" style="cursor:pointer; display:inline-flex; align-items:center; gap:8px;">
                <img src="${av}" class="avatar-round-mini">
                <span style="font-weight:600;">@${nom}</span>
            </div>
            ${btnSuppr}
        </div>
        <div class="post-content" style="margin-top:10px;">${post.contenu || ""}</div>
        ${media}
        <div class="post-actions-bar">
            <button class="btn-action" onclick="liker('${post._id}')"><i class="fa-solid fa-heart" style="color:${(post.likes && post.likes.length > 0) ? 'var(--danger)':''}"></i> ${post.likes ? post.likes.length : 0}</button>
        </div>
        <div class="comments-section">
            <div>${cmts}</div>
            <div class="add-comment" style="display:flex; gap:8px; margin-top:8px;">
                <input type="text" id="input-comment-${post._id}" placeholder="Ajouter un commentaire..." style="flex:1;">
                <button class="btn-action" onclick="ajouterCommentaire('${post._id}')">Envoyer</button>
            </div>
        </div>`;
    return div;
}

async function liker(postId) {
    const res = await fetchAPI(`/posts/${postId}/like`, { method: "POST" });
    if (res && res.ok) { 
        if(document.getElementById('feed-section').style.display === 'block') chargerFeed(); 
        else chargerProfil(); 
    }
}

async function ajouterCommentaire(postId) {
    const input = document.getElementById(`input-comment-${postId}`);
    if (!input || !input.value.trim()) return;
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
    const input = document.getElementById("search-username");
    const q = input ? input.value.trim() : "";
    if (!q) return;
    const res = await fetchAPI(`/users/search?q=${encodeURIComponent(q)}`);
    const users = await res.json();
    const container = document.getElementById("search-results");
    if(!container) return;
    container.innerHTML = users.length === 0 ? "<p style='color:gray; font-size:12px;'>Aucun résultat.</p>" : "";
    
    users.forEach(u => {
        const div = document.createElement("div");
        div.className = "user-result";
        div.innerHTML = `<span>@${u.pseudo}</span><button class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="suivreUtilisateur('${u._id}')">Suivre</button>`;
        container.appendChild(div);
    });
}

async function rechercherUtilisateursMobile() {
    const query = document.getElementById("mob-search-input").value.trim();
    const container = document.getElementById("mob-search-results-container");
    if (!query) { container.innerHTML = ""; return; }

    const res = await fetchAPI(`/users/search?q=${encodeURIComponent(query)}`);
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

async function suivreUtilisateur(userId) {
    const res = await fetchAPI(`/users/${userId}/follow`, { method: "POST" });
    if(res && res.ok) { afficherToast("Abonnement activé !"); chargerProfil(userId); }
}

async function desuivreUtilisateur(userId) {
    const res = await fetchAPI(`/users/${userId}/unfollow`, { method: "POST" });
    if(res && res.ok) { afficherToast("Abonnement retiré."); chargerProfil(userId); }
}

// --- MESSAGERIE EXCELLENCE UNIFIÉE ---
async function chargerMessagerie(forceTargetUserId = null) {
    chargerStatuts(); 
    const res = await fetchAPI("/conversations");
    if (res && res.ok) {
        const conversations = await res.json();
        const container = document.getElementById("contacts-container");
        if(!container) return;
        container.innerHTML = "";

        conversations.forEach(c => {
            const contact = c.displayProfiles && c.displayProfiles.length > 0 ? c.displayProfiles[0] : { pseudo: "Groupe", avatarUrl: null };
            const av = contact.avatarUrl ? `${API_URL}${contact.avatarUrl}` : PAR_DEFAUT_AVATAR;
            
            let snip = c.lastMessage ? (c.lastMessage.texte.length > 20 ? c.lastMessage.texte.substring(0,20)+"..." : c.lastMessage.texte) : "<span class='snippet-vide'>Nouvelle discussion</span>";
            
            const div = document.createElement("div");
            div.className = "contact-item";
            div.id = `conv-${c._id}`;
            div.innerHTML = `
                <img src="${av}" class="avatar-round-mini" style="width:38px; height:38px; flex-shrink:0;">
                <div class="contact-item-meta" style="overflow:hidden;">
                    <span class="contact-pseudo" style="font-weight:600; display:block;">@${c.pseudo}</span>
                    <span class="contact-snippet" style="font-size:12px; color:var(--text-muted); display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${snip}</span>
                </div>`;
            div.onclick = () => chargerDiscussion(c._id, true);
            container.appendChild(div);
        });

        if (forceTargetUserId) {
            ouvrirOuCreerConversation(forceTargetUserId);
        }
    }
}

async function ouvrirOuCreerConversation(targetUserId) {
    const res = await fetchAPI("/conversations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantIds: [targetUserId], isGroup: false })
    });
    if (res && res.ok) {
        const conv = await res.json();
        chargerDiscussion(conv._id, targetUserId, "Discussion", true);
    }
}

async function chargerDiscussion(convId, destinataireId, nomDestinataire, forcerScroll = false) {
    chatActifConvId = convId;
    chatActifDestinataireId = destinataireId;

    const res = await fetchAPI(`/conversations/${convId}/messages`);
    if (res && res.ok) {
        const msgs = await res.json();
        const container = document.getElementById("messages-history");
        if(!container) return;
        
        const savedColor = localStorage.getItem(`chat_color_${userId}`) || '#dfb142';
        appliquerCouleurChat(savedColor);
        const picker = document.getElementById('chat-color-picker');
        if (picker) picker.value = savedColor;

        document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
        const activeItem = document.getElementById(`contact-${userId}`);
        const headerText = document.getElementById("chat-header-text");
        if (activeItem && headerText) {
            activeItem.classList.add('active');
            headerText.innerText = activeItem.querySelector('.contact-pseudo').innerText;
        }

        const etatActuel = JSON.stringify(msgs);
        if (etatActuel !== memoireDiscussionState || forcerScroll) {
            container.innerHTML = "";
            msgs.forEach(m => {
                const heure = new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                
                let monId = null;
                const tokenStr = localStorage.getItem("social_token");
                if(tokenStr) monId = JSON.parse(atob(tokenStr.split('.')[1])).id;
                
                const estMoi = m.fromId === monId;
                
                let cocheHTML = "";
                if (estMoi) {
                    const estLu = m.readBy && m.readBy.some(r => r.userId !== monId);
                    cocheHTML = estLu ? `<span class="msg-status-tick tick-read"><i class="fa-solid fa-check-double"></i></span>` 
                                      : `<span class="msg-status-tick tick-sent"><i class="fa-solid fa-check"></i></span>`;
                }

                let contenuHTML = m.texte || "";
                if (m.mediaType === 'audio') {
                    contenuHTML = `<audio src="${API_URL}${m.mediaUrl}" controls class="chat-voice-player"></audio>`;
                } else if (m.mediaUrl) {
                    contenuHTML = `<img src="${API_URL}${m.mediaUrl}" style="max-width: 200px; border-radius: 8px;"><br>${m.texte || ""}`;
                }

                const btnSupprimer = `<button class="btn-delete-msg" onclick="supprimerMessage('${m._id}')"><i class="fa-solid fa-trash"></i></button>`;

                const div = document.createElement("div");
                div.className = `message-bubble ${estMoi ? 'sent' : 'received'}`;
                div.innerHTML = `${contenuHTML} <span class="msg-timestamp">${heure} ${cocheHTML}</span> ${btnSupprimer}`;
                container.appendChild(div);
            });
            memoireDiscussionState = etatActuel;
            if (forcerScroll) container.scrollTop = container.scrollHeight;
        }

        const inputBlock = document.getElementById("chat-input-block");
        const mobLayout = document.getElementById("mobile-messages-layout");
        if(inputBlock) inputBlock.style.display = "flex";
        if(mobLayout) mobLayout.classList.add("chat-active");
        
        await fetchAPI(`/conversations/${convId}/read`, { method: "POST" });
    }
}

async function envoyerMessage() {
    const input = document.getElementById("message-text");
    if (!input || !input.value.trim() || !chatActifUserId) return;

    if (socket) socket.emit('stopTyping', chatActifConvId);

    const res = await fetchAPI(`/conversations/${chatActifConvId}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texte: input.value })
    });
    if (res && res.ok) { 
        input.value = ""; 
        chargerDiscussion(chatActifConvId, chatActifDestinataireId, null, true); 
        chargerMessagerie(); 
    }
}

// --- GESTION DU PANNEAU DE PARAMÈTRES CHAT ---
function toggleChatSettings() {
    const drawer = document.getElementById('chat-settings-drawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden');
    
    if (!drawer.classList.contains('hidden') && chatActifUserId) {
        chargerParametresChat(chatActifUserId);
    }
}

function chargerParametresChat(userId) {
    const color = localStorage.getItem(`chat_color_${userId}`) || '#dfb142';
    const bg = localStorage.getItem(`chat_bg_${userId}`) || 'default';
    const isEphemere = localStorage.getItem(`chat_ephemere_${userId}`) === 'true';
    const isMuted = localStorage.getItem(`chat_mute_${userId}`) === 'true';

    const colorPicker = document.getElementById('chat-color-picker');
    const bgSelect = document.getElementById('chat-bg-select');
    const toggleEph = document.getElementById('toggle-ephemeral');
    const toggleMut = document.getElementById('toggle-mute');

    if(colorPicker) colorPicker.value = color;
    if(bgSelect) bgSelect.value = bg;
    if(toggleEph) toggleEph.checked = isEphemere;
    if(toggleMut) toggleMut.checked = isMuted;

    appliquerCouleurChat(color);
    appliquerFondChat(bg);
}

function changerFondChat(typeFond) {
    if (!chatActifConvId) return;
    localStorage.setItem(`chat_bg_${chatActifConvId}`, typeFond);
    appliquerFondChat(typeFond);
}

function appliquerFondChat(typeFond) {
    const container = document.getElementById("messages-history");
    if (!container) return;
    
    container.className = "messages-history"; 
    if (typeFond !== 'default') {
        container.classList.add(`chat-bg-${typeFond}`);
    }
}

function toggleEphemere(actif) {
    if (!chatActifConvId) return;
    localStorage.setItem(`chat_ephemere_${chatActifConvId}`, actif);
    afficherToast(actif ? "⏱️ Messages éphémères activés (24h)" : "⏱️ Messages éphémères désactivés");
    if (socket) socket.emit('toggleEphemere', { cibleId: chatActifUserId, actif });
}

// Renommé pour éviter le conflit avec le mute des Reels
function toggleMuteChat(actif) {
    if (!chatActifUserId) return;
    localStorage.setItem(`chat_mute_${chatActifUserId}`, actif);
    afficherToast(actif ? "🔇 Discussion en mode silence" : "🔔 Notifications réactivées");
}

async function viderHistoriqueChat() {
    if (!chatActifUserId) return;
    if (!confirm("⚠️ Attention : Voulez-vous vraiment supprimer tous les messages de cette conversation ?")) return;

    const res = await fetchAPI(`/messages/clear/${chatActifUserId}`, { method: "DELETE" });
    if (res && res.ok) {
        document.getElementById("messages-history").innerHTML = "";
        memoireDiscussionState = "";
        afficherToast("Conversation vidée avec succès");
        toggleChatSettings();
    }
}

function fermerChatMobile() {
    chatActifConvId = null; 
    chatActifDestinataireId = null;
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
            if (audioBlob.size > 0 && chatActifConvId) {
                const formData = new FormData();
                formData.append("media", audioBlob, "vocal.webm");
                const res = await fetchAPI(`/conversations/${chatActifConvId}/messages`, {
                    method: "POST", body: formData
                });
                if (res && res.ok) {
                    chargerDiscussion(chatActifConvId, chatActifDestinataireId, null, true);
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
        if(!container) return;
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
    if(!listContainer) return;
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
    if(!modal) return;
    modal.style.display = 'flex';

    async function afficherIndex() {
        if (index >= statusArray.length) { fermerVisionneuseStatut(); return; }
        const s = statusArray[index];
        
        await fetchAPI(`/statuses/${s._id}/view`, { method: "POST" });

        document.getElementById('viewer-author-name').innerText = `@${s.author}`;
        document.getElementById('viewer-author-avatar').src = s.avatarUrl ? `${API_URL}${s.avatarUrl}` : PAR_DEFAUT_AVATAR;
        document.getElementById('viewer-status-time').innerText = formaterDateRelative(s.date);

        const body = document.getElementById('viewer-content-area');
        if (s.type === 'image') {
            body.innerHTML = `<div style='text-align:center;'><img src="${API_URL}${s.mediaUrl}" style="max-width:100%; max-height:70vh;"><p style='color:white; margin-top:10px; font-size:14px;'>${s.text || ""}</p></div>`;
        } else {
            body.innerHTML = `<div class="big-text-status">"${s.text}"</div>`;
        }

        const fillBar = document.getElementById('status-progress-bar');
        if(fillBar) {
            fillBar.style.transition = 'none'; fillBar.style.width = '0%';
            setTimeout(() => { fillBar.style.transition = 'width 5000ms linear'; fillBar.style.width = '100%'; }, 50);
        }

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

// --- PERSONNALISATION DES COULEURS ---
function changerCouleurChat(couleur) {
    if (!chatActifUserId) return;
    localStorage.setItem(`chat_color_${chatActifUserId}`, couleur);
    appliquerCouleurChat(couleur);
}

function appliquerCouleurChat(couleur) {
    document.documentElement.style.setProperty('--chat-theme-color', couleur);
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

// --- SUPPRESSION DE MESSAGES ---
async function supprimerMessage(messageId) {
    if (!confirm("Voulez-vous vraiment supprimer ce message ?")) return;
    
    const res = await fetchAPI(`/messages/${messageId}`, { method: "DELETE" });
    if (res && res.ok) {
        afficherToast("Message supprimé");
        chargerDiscussion(chatActifUserId, true); 
    }
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

// ============================================================================
// GESTION DES REELS (FLUX VIDÉO JO SOCIO)
// ============================================================================
function initialiserReelsObserver() {
    const container = document.getElementById('reels-feed');
    if (!container) return;

    const options = { root: container, threshold: 0.6 };
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = entry.target.querySelector('.reel-video');
            if (!video) return;
            if (entry.isIntersecting) {
                video.play().catch(err => {
                    console.log("Lecture auto bloquée par le navigateur : attente d'interaction.");
                });
            } else {
                video.pause();
                video.currentTime = 0;
            }
        });
    }, options);

    document.querySelectorAll('.reel-item').forEach(item => observer.observe(item));
}

// Renommé en toggleMuteReel pour éviter le conflit avec toggleMuteChat
function toggleMuteReel(btn) {
    const reelItem = btn.closest('.reel-item');
    const video = reelItem.querySelector('.reel-video');
    const icon = btn.querySelector('i');

    if (video.muted) {
        video.muted = false;
        icon.className = "fa-solid fa-volume-high";
    } else {
        video.muted = true;
        icon.className = "fa-solid fa-volume-xmark";
    }
}

function initialiserDoubleTapReels() {
    const reels = document.querySelectorAll('.reel-item');
    reels.forEach(reel => {
        const video = reel.querySelector('.reel-video');
        const videoId = reel.dataset.videoId;
        let dernierClic = 0;

        if(!video) return;
        video.addEventListener('click', (e) => {
            const tempsActuel = new Date().getTime();
            const ecart = tempsActuel - dernierClic;

            if (ecart < 300 && ecart > 0) {
                e.preventDefault();
                declencherDoubleTapLike(reel, videoId);
                dernierClic = 0; 
            } else {
                dernierClic = tempsActuel;
            }
        });
    });
}

function declencherDoubleTapLike(reel, videoId) {
    const grosCoeur = reel.querySelector('.reel-big-heart');
    const btnLike = reel.querySelector('.btn-like');
    if(!btnLike) return;
    const likeIcon = btnLike.querySelector('i');
    const likeCountSpan = btnLike.querySelector('span');

    if (grosCoeur) {
        grosCoeur.classList.remove('animate');
        void grosCoeur.offsetWidth; 
        grosCoeur.classList.add('animate');
    }

    if (!btnLike.classList.contains('liked')) {
        btnLike.classList.add('liked');
        likeIcon.classList.remove('fa-regular');
        likeIcon.classList.add('fa-solid');

        let nbLikes = parseInt(likeCountSpan.innerText.replace(/\D/g, '')) || 0;
        likeCountSpan.innerText = formatNombreLikes(nbLikes + 1);

        if (typeof envoyerLikeApi === "function") {
            envoyerLikeApi(videoId);
        }
    }
}

function formatNombreLikes(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + ' M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + ' K';
    return num.toString();
}

async function envoyerLikeApi(videoId) {
    try {
        const token = localStorage.getItem("social_token");
        await fetch(`${API_URL}/api/reels/${videoId}/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        });
    } catch (erreur) {
        console.error("Erreur de synchronisation du like :", erreur);
    }
}

// Fonctions additionnelles de Reels
function likerVideo(videoId) {
    const reel = document.querySelector(`.reel-item[data-video-id="${videoId}"]`);
    if(reel) declencherDoubleTapLike(reel, videoId);
}

function ouvrirCommentaires(videoId) {
    afficherToast("Ouverture des commentaires du Reel #" + videoId);
}

function partagerVideo(videoId) {
    afficherToast("Lien du Reel #" + videoId + " copié dans le presse-papier !");
}

function envoyerMessageVideo(videoId) {
    afficherToast("Reel #" + videoId + " prêt à être partagé en message privé.");
}

// ============================================================================
// FILTRES ET RECHERCHE MESSAGERIE
// ============================================================================
function initialiserFiltresMessagerie() {
    const chips = document.querySelectorAll('.msg-filter-chips-container .filter-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', (e) => {
            chips.forEach(c => c.classList.remove('active'));
            const cible = e.currentTarget;
            cible.classList.add('active');
            const critere = cible.dataset.filter;
            const searchInput = document.getElementById('msg-search-input');
            filtrerListeDiscussions(critere, searchInput ? searchInput.value : "");
        });
    });
}

function initialiserRechercheMessagerie() {
    const searchInput = document.getElementById('msg-search-input');
    if (!searchInput) return;
    searchInput.addEventListener('input', (e) => {
        const terme = e.target.value.toLowerCase().trim();
        const chipActif = document.querySelector('.filter-chip.active');
        const critere = chipActif ? chipActif.dataset.filter : 'toutes';
        filtrerListeDiscussions(critere, terme);
    });
}

// Correction majeure : utilisation des sélecteurs CSS réels (.contact-pseudo et .contact-snippet)
function filtrerListeDiscussions(critere, termeRecherche = "") {
    const contacts = document.querySelectorAll('.contact-item');
    contacts.forEach(contact => {
        const nomEl = contact.querySelector('.contact-pseudo');
        const msgEl = contact.querySelector('.contact-snippet');
        const nom = (nomEl ? nomEl.innerText : "").toLowerCase();
        const dernierMsg = (msgEl ? msgEl.innerText : "").toLowerCase();
        
        const estNonLu = contact.classList.contains('unread'); 
        const estFavori = contact.classList.contains('favorite');
        const estGroupe = contact.dataset.isGroup === "true";

        const correspondRecherche = nom.includes(termeRecherche) || dernierMsg.includes(termeRecherche);

        let correspondCritere = true;
        if (critere === 'non-lues') correspondCritere = estNonLu;
        if (critere === 'favoris') correspondCritere = estFavori;
        if (critere === 'groupes') correspondCritere = estGroupe;

        if (correspondRecherche && correspondCritere) {
            contact.style.display = "flex";
        } else {
            contact.style.display = "none";
        }
    });
}

// --- ACTIONS ET PARAMÈTRES AVANCÉS JO SOCIO ---
function ouvrirCameraStatut() {
    ouvrirModaleCreationStatut();
}

function toggleModaleParametres() {
    const modale = document.getElementById('josocio-settings-modal');
    if (!modale) return;
    if (modale.classList.contains('active')) {
        modale.classList.remove('active');
        document.body.style.overflow = "auto"; 
    } else {
        modale.classList.add('active');
        document.body.style.overflow = "hidden"; 
    }
}

function fermerModaleSiBackground(event) {
    if (event.target.id === 'josocio-settings-modal') {
        toggleModaleParametres();
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === "Escape") {
        const modale = document.getElementById('josocio-settings-modal');
        if (modale && modale.classList.contains('active')) {
            toggleModaleParametres();
        }
    }
});

function ouvrirSection(section) {
    switch(section) {
        case 'compte': alert("Accès aux paramètres de sécurité et confidentialité."); break;
        case 'chats': alert("Modification du fond d'écran et des thèmes."); break;
        case 'notifs': alert("Gestion des sons et vibreur."); break;
        case 'stockage': alert("Gestion du cache et téléchargements automatiques."); break;
        case 'ia': alert("Configuration de l'Assistant IA Jo Socio."); break;
        default: break;
    }
}

function deconnecterJoSocio() {
    if (confirm("Êtes-vous sûr de vouloir vous déconnecter de Jo Socio ?")) {
        localStorage.removeItem("social_token");
        sessionStorage.clear();
        location.reload();
    }
}

function rechercherDansChat() {
    const terme = prompt("Entrez le mot ou la phrase à rechercher dans la discussion :");
    if (!terme) return;
    const bulles = document.querySelectorAll(".message-bubble");
    let trouve = false;
    bulles.forEach(b => {
        if (b.innerText.toLowerCase().includes(terme.toLowerCase())) {
            b.style.border = "2px solid var(--gold, #dfb142)";
            if (!trouve) { b.scrollIntoView({ behavior: "smooth", block: "center" }); trouve = true; }
            setTimeout(() => b.style.border = "none", 4000);
        }
    });
    if (!trouve) afficherToast("Aucun message correspondant trouvé.");
}

function exporterDiscussion() {
    if (!chatActifUserId) return afficherToast("Aucune discussion sélectionnée.");
    const bulles = document.querySelectorAll(".message-bubble");
    let texteExport = `--- Export Discussion Jo Socio (ID: ${chatActifUserId}) ---\n\n`;
    bulles.forEach(b => {
        const estMoi = b.classList.contains("sent") ? "Moi" : "Contact";
        texteExport += `[${estMoi}] : ${b.innerText.replace("\n", " ")}\n`;
    });
    const blob = new Blob([texteExport], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `discussion_${chatActifUserId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}