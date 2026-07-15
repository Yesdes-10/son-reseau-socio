const API_URL = window.location.origin;
const PAR_DEFAUT_AVATAR = "https://www.w3schools.com/howto/img_avatar.png";

let fichierImageSelectionne = null; 
let fichierStatutSelectionne = null;
let chatActifUserId = null; 
let cropperInstance = null;
let dernierIdNotification = null;
let memoireDiscussionState = ""; 
let statusTimerInterval = null;

// Variables hardware d'enregistrement vocal
let mediaRecorder = null;
let audioStream = null; // Ajout pour gestion sécurisée des pistes audio
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
    try {
        const res = await fetch(`${API_URL}${endpoint}`, options);
        if (res.status === 401 || res.status === 403) {
            localStorage.removeItem("social_token");
            location.reload();
            return null;
        }
        return res;
    } catch (error) {
        console.error("Erreur réseau fetchAPI :", error);
        afficherToast("Erreur de connexion au serveur.");
        return null;
    }
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
    const container = document.getElementById("toast-container");
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
        const authScreen = document.getElementById("auth-screen");
        const mainScreen = document.getElementById("main-screen");
        if (authScreen) authScreen.style.display = "none";
        if (mainScreen) mainScreen.style.display = "block";

        mettreAjourAvatarsEtInfosEnCochiffre();
        naviguerVers('feed');
        actualiserBadgeNotifications(true);
        
        // --- INITIALISATION DU MOTEUR WEBSOCKETS ---
        initialiserWebSockets(token);

        // Écouteur d'événement pour l'indicateur de frappe
        const inputMessage = document.getElementById("message-text");
        if (inputMessage) {
            inputMessage.addEventListener('input', gererIndicateurDeFrappe);
        }
    }
};

// ============================================================================
// MOTEUR WEBSOCKETS (ZÉRO LATENCE)
// ============================================================================
function initialiserWebSockets(token) {
    if (typeof io === 'undefined') {
        console.warn("La bibliothèque Socket.io n'est pas chargée.");
        return;
    }
    socket = io(API_URL, { auth: { token } });

    socket.on('newMessage', (msg) => {
        const messagesSection = document.getElementById('messages-section');
        if (chatActifUserId === msg.fromId && messagesSection && messagesSection.style.display === 'block') {
            chargerDiscussion(chatActifUserId, true);
            socket.emit('markAsRead', msg.fromId);
        } else {
            chargerMessagerie();
            actualiserBadgeNotifications(false);
            afficherToast("Nouveau message reçu !");
        }
    });

    socket.on('userTyping', (userId) => {
        if (chatActifUserId === userId) {
            const typingInd = document.getElementById('typing-indicator');
            if (typingInd) typingInd.style.display = 'block';
            const hist = document.getElementById("messages-history");
            if (hist) hist.scrollTop = hist.scrollHeight;
        }
    });

    socket.on('userStoppedTyping', (userId) => {
        if (chatActifUserId === userId) {
            const typingInd = document.getElementById('typing-indicator');
            if (typingInd) typingInd.style.display = 'none';
        }
    });

    socket.on('messagesReadBy', (userId) => {
        if (chatActifUserId === userId) {
            chargerDiscussion(userId, false); 
        }
    });
}

function gererIndicateurDeFrappe() {
    if (!chatActifUserId || !socket) return;
    socket.emit('typing', chatActifUserId);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stopTyping', chatActifUserId);
    }, 1500); 
}

// ============================================================================
// LOGIQUE DE NAVIGATION ET DE VUES
// ============================================================================
function naviguerVers(section, targetId = null) {
    document.querySelectorAll('.menu-item, .mobile-nav-item').forEach(el => el.classList.remove('active'));
    
    ['feed-section', 'profile-section', 'messages-section', 'notifications-section'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
    });

    if (section === 'messages') {
        const mobLayout = document.getElementById('mobile-messages-layout');
        if (mobLayout) mobLayout.classList.remove('chat-active');
        chatActifUserId = null;
    }

    const activeDesk = document.getElementById(`nav-${section}`);
    const activeMob = document.getElementById(`mob-nav-${section}`);
    if (activeDesk) activeDesk.classList.add('active');
    if (activeMob) activeMob.classList.add('active');

    if (section === 'feed') {
        const el = document.getElementById('feed-section');
        if (el) el.style.display = "block";
        chargerFeed();
    } else if (section === 'profil') {
        const el = document.getElementById('profile-section');
        if (el) el.style.display = "block";
        chargerProfil(targetId);
    } else if (section === 'messages') {
        const el = document.getElementById('messages-section');
        if (el) el.style.display = "block";
        chargerMessagerie(targetId);
    } else if (section === 'notifications') {
        const el = document.getElementById('notifications-section');
        if (el) el.style.display = "block";
        chargerNotifications();
    }
}

// --- AUTHENTIFICATION ---
async function inscrire() {
    const pseudoEl = document.getElementById("pseudo");
    const passwordEl = document.getElementById("password");
    if (!pseudoEl || !passwordEl) return;

    const pseudo = pseudoEl.value.trim();
    const password = passwordEl.value.trim();
    if (!pseudo || !password) return afficherToast("Champs vides.");

    try {
        const res = await fetch(`${API_URL}/auth/inscription`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pseudo, password })
        });
        const data = await res.json();
        const authMsg = document.getElementById("auth-message");
        if (authMsg) {
            if (res.ok) {
                authMsg.style.color = "green";
                authMsg.innerText = "Inscription réussie ! Connectez-vous.";
            } else {
                authMsg.style.color = "var(--danger)";
                authMsg.innerText = data.erreur || "Erreur d'inscription.";
            }
        }
    } catch (err) {
        afficherToast("Erreur de connexion au serveur.");
    }
}

async function connecter() {
    const pseudoEl = document.getElementById("pseudo");
    const passwordEl = document.getElementById("password");
    if (!pseudoEl || !passwordEl) return;

    const pseudo = pseudoEl.value.trim();
    const password = passwordEl.value.trim();

    try {
        const res = await fetch(`${API_URL}/auth/connexion`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pseudo, password })
        });
        const data = await res.json();
        if (res.ok && data.token) {
            localStorage.setItem("social_token", data.token);
            location.reload();
        } else {
            const authMsg = document.getElementById("auth-message");
            if (authMsg) {
                authMsg.style.color = "var(--danger)";
                authMsg.innerText = data.erreur || "Identifiants incorrects.";
            }
        }
    } catch (err) {
        afficherToast("Erreur de connexion au serveur.");
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
        
        const elSidebarAvatar = document.getElementById("sidebar-avatar");
        const elFeedAvatar = document.getElementById("feed-creator-avatar");
        const elStatusAvatar = document.getElementById("my-status-avatar-img");
        const elSidebarPseudo = document.getElementById("sidebar-pseudo");

        if (elSidebarAvatar) elSidebarAvatar.src = av;
        if (elFeedAvatar) elFeedAvatar.src = av;
        if (elStatusAvatar) elStatusAvatar.src = av;
        if (elSidebarPseudo) elSidebarPseudo.innerText = "@" + moi.pseudo;
    }
}

async function chargerProfil(userId = null) {
    const estMonProfil = !userId || userId === "me";
    const url = estMonProfil ? `/users/me` : `/users/${userId}`;
    const res = await fetchAPI(url);

    if (res && res.ok) {
        const data = await res.json();
        if (data.redirectMe) return chargerProfil("me");

        const elPseudo = document.getElementById("profile-pseudo");
        const elAvatar = document.getElementById("profile-avatar-img");
        if (elPseudo) elPseudo.innerText = "@" + data.pseudo;
        if (elAvatar) elAvatar.src = data.avatarUrl ? `${API_URL}${data.avatarUrl}` : PAR_DEFAUT_AVATAR;

        const labelModif = document.getElementById("change-avatar-label");
        const actionBox = document.getElementById("profile-action-container");
        const settingsBox = document.getElementById("profile-settings-container");
        const postsBox = document.getElementById("profile-posts-container");
        const statsBox = document.getElementById("profile-stats");
        
        if (actionBox) actionBox.innerHTML = ""; 
        if (settingsBox) settingsBox.innerHTML = ""; 
        if (postsBox) postsBox.innerHTML = "";

        if (estMonProfil) {
            if (labelModif) labelModif.style.display = "flex"; 
            const nbPosts = (data.mesPosts || []).length;
            if (statsBox) statsBox.innerText = `Abonnements : ${data.abonnementsCount || 0} | Publications : ${nbPosts}`;
            
            if (settingsBox) {
                settingsBox.innerHTML = `
                    <div style="margin-top:20px; border-top:1px solid var(--border-color); padding-top:15px;">
                        <div style="display:flex; justify-content:center; gap:10px; margin-bottom:15px;">
                            <input type="text" id="input-nouveau-pseudo" placeholder="Changer pseudo" style="width:auto;">
                            <button class="btn-secondary" onclick="modifierMonPseudo()">Modifier</button>
                        </div>
                        <button onclick="supprimerMonCompte()" style="background:var(--danger); color:white; padding:8px 12px; border-radius:4px;">Supprimer le compte</button>
                    </div>`;
            }
            if (!postsBox) return;
            if (nbPosts === 0) {
                postsBox.innerHTML = "<p style='color:var(--text-muted);'>Aucun post.</p>"; 
                return; 
            }
            data.mesPosts.forEach(p => postsBox.appendChild(creerElementPost({...p, auteur: { pseudo: data.pseudo, avatarUrl: data.avatarUrl }, estLeMien: true})));
        } else {
            if (labelModif) labelModif.style.display = "none"; 
            const nbPosts = (data.posts || []).length;
            if (statsBox) statsBox.innerText = `Publications : ${data.postsCount || nbPosts}`;
            
            let btnF = data.estAbonne ? `<button class="btn-secondary" onclick="desuivreUtilisateur('${data._id}')">Ne plus suivre</button>` : `<button class="btn-primary" onclick="suivreUtilisateur('${data._id}')">Suivre</button>`;
            if (actionBox) {
                actionBox.innerHTML = `<div style="display:flex; justify-content:center; gap:10px;">${btnF}<button class="btn-primary" onclick="naviguerVers('messages', '${data._id}')"><i class="fa-solid fa-envelope"></i> Message</button></div>`;
            }
            if (!postsBox) return;
            if (nbPosts === 0) { 
                postsBox.innerHTML = "<p style='color:var(--text-muted);'>Aucun post.</p>"; 
                return; 
            }
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
        const cropModal = document.getElementById("crop-modal");
        if (!imageElement || !cropModal) return;
        
        imageElement.src = e.target.result;
        cropModal.style.display = "flex";
        if (cropperInstance) cropperInstance.destroy();
        cropperInstance = new Cropper(imageElement, { aspectRatio: 1, viewMode: 1, background: false });
    };
    reader.readAsDataURL(file);
}

function fermerModaleRecadrage() {
    const cropModal = document.getElementById("crop-modal");
    const fileInput = document.getElementById("avatar-file-input");
    if (cropModal) cropModal.style.display = "none";
    if (fileInput) fileInput.value = "";
    if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
}

function sauvegarderAvatarRecadre() {
    if (!cropperInstance) return;
    cropperInstance.getCroppedCanvas({ width: 200, height: 200 }).toBlob(async (blob) => {
        if (!blob) return;
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
    const inputEl = document.getElementById('input-nouveau-pseudo');
    if (!inputEl) return;
    const nouveauPseudo = inputEl.value.trim();
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

// --- SYSTÈME DE POSTS & FIL D'ACTUALITÉ ---
function previsualiserImage(event) {
    const fichier = event.target.files[0];
    if (fichier) {
        fichierImageSelectionne = fichier;
        const reader = new FileReader();
        reader.onload = function(e) {
            const previewContainer = document.getElementById("preview-container");
            const imgPreview = document.getElementById("image-preview");
            const vidPreview = document.getElementById("video-preview");
            if (!previewContainer || !imgPreview || !vidPreview) return;

            previewContainer.style.display = "block";
            if (fichier.type.startsWith("video/")) {
                imgPreview.style.display = "none";
                vidPreview.src = e.target.result;
                vidPreview.style.display = "block";
            } else {
                vidPreview.style.display = "none";
                imgPreview.src = e.target.result;
                imgPreview.style.display = "block";
            }
        };
        reader.readAsDataURL(fichier);
    }
}

function annulerImage() {
    fichierImageSelectionne = null;
    const postImg = document.getElementById("post-image");
    const previewContainer = document.getElementById("preview-container");
    if (postImg) postImg.value = "";
    if (previewContainer) previewContainer.style.display = "none";
}

async function publier() {
    const contentEl = document.getElementById("post-content");
    if (!contentEl) return;
    const contenu = contentEl.value;
    if (!contenu.trim() && !fichierImageSelectionne) return;

    const formData = new FormData();
    formData.append("contenu", contenu);
    if (fichierImageSelectionne) formData.append("image", fichierImageSelectionne);

    const res = await fetchAPI("/posts", { method: "POST", body: formData });
    if (res && res.ok) {
        contentEl.value = ""; 
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
    if (!container) return;
    container.innerHTML = (posts || []).length === 0 ? "<p style='color:var(--text-muted);'>Aucun post récent.</p>" : "";
    (posts || []).forEach(p => container.appendChild(creerElementPost(p)));
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
            cmts += `<div class="comment"><strong>@${c.auteur || "Anonyme"}</strong> : ${c.texte || ""}</div>`;
        });
    }

    const likesCount = (post.likes || []).length;
    let btnSuppr = post.estLeMien ? `<button class="btn-action" style="color:var(--danger);" onclick="supprimerPost('${post._id}')"><i class="fa-solid fa-trash"></i></button>` : "";
    
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
            <div onclick="naviguerVers('profil', '${post.auteurId}')" style="cursor:pointer; display:inline-flex; align-items:center; gap:8px;">
                <img src="${av}" class="avatar-round-mini">
                <span style="font-weight:600;">@${nom}</span>
            </div>
            ${btnSuppr}
        </div>
        <div class="post-content" style="margin-top:10px;">${post.contenu || ""}</div>
        ${media}
        <div class="post-actions-bar">
            <button class="btn-action" onclick="liker('${post._id}')"><i class="fa-solid fa-heart" style="color:${likesCount > 0 ? 'var(--danger)':''}"></i> ${likesCount}</button>
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
    if (res && res.ok) { 
        const feedSec = document.getElementById('feed-section');
        if (feedSec && feedSec.style.display === 'block') chargerFeed(); 
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
    if (confirm("Supprimer ce post ?")) { 
        await fetchAPI(`/posts/${postId}`, { method: "DELETE" }); 
        chargerFeed(); 
    }
}

// --- RECHERCHE ET CONTACTS ---
async function rechercherUtilisateurs() {
    const inputEl = document.getElementById("search-username");
    if (!inputEl) return;
    const q = inputEl.value.trim();
    if (!q) return;
    
    const res = await fetchAPI(`/users/search?q=${encodeURIComponent(q)}`);
    if (!res || !res.ok) return;
    const users = await res.json();
    const container = document.getElementById("search-results");
    if (!container) return;
    container.innerHTML = (users || []).length === 0 ? "<p style='color:gray; font-size:12px;'>Aucun résultat.</p>" : "";
    
    (users || []).forEach(u => {
        const div = document.createElement("div");
        div.className = "user-result";
        div.innerHTML = `<span>@${u.pseudo}</span><button class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="suivreUtilisateur('${u._id}')">Suivre</button>`;
        container.appendChild(div);
    });
}

async function suivreUtilisateur(userId) {
    const res = await fetchAPI(`/users/${userId}/follow`, { method: "POST" });
    if (res && res.ok) { afficherToast("Abonnement activé !"); chargerProfil(userId); }
}

async function desuivreUtilisateur(userId) {
    const res = await fetchAPI(`/users/${userId}/unfollow`, { method: "POST" });
    if (res && res.ok) { afficherToast("Abonnement retiré."); chargerProfil(userId); }
}

// --- MESSAGERIE EXCELLENCE UNIFIÉE ---
async function chargerMessagerie(forceUserChatId = null) {
    chargerStatuts(); 
    const res = await fetchAPI("/messages/contacts");
    if (res && res.ok) {
        const contacts = await res.json();
        const container = document.getElementById("contacts-container");
        if (!container) return;
        container.innerHTML = "";

        (contacts || []).forEach(c => {
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
        if (!container) return;
        
        // --- Application de la couleur sauvegardée ---
        const savedColor = localStorage.getItem(`chat_color_${userId}`) || '#dfb142'; 
        appliquerCouleurChat(savedColor);
        const picker = document.getElementById('chat-color-picker');
        if (picker) picker.value = savedColor;
        // --------------------------------------------------------

        document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
        const activeItem = document.getElementById(`contact-${userId}`);
        const chatHeaderText = document.getElementById("chat-header-text");
        if (activeItem) {
            activeItem.classList.add('active');
            if (chatHeaderText) {
                const pseudoEl = activeItem.querySelector('.contact-pseudo');
                if (pseudoEl) chatHeaderText.innerText = pseudoEl.innerText;
            }
        }

        const etatActuel = JSON.stringify(msgs);
        if (etatActuel !== memoireDiscussionState || forcerScroll) {
            container.innerHTML = "";
            (msgs || []).forEach(m => {
                const heure = new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const estMoi = m.fromId !== userId;
                
                let cocheHTML = "";
                if (estMoi) {
                    if (m.status === 'read') cocheHTML = `<span class="msg-status-tick tick-read"><i class="fa-solid fa-check-double"></i></span>`;
                    else if (m.status === 'delivered') cocheHTML = `<span class="msg-status-tick tick-delivered"><i class="fa-solid fa-check-double"></i></span>`;
                    else cocheHTML = `<span class="msg-status-tick tick-sent"><i class="fa-solid fa-check"></i></span>`;
                }

                let contenuHTML = m.texte || "";
                if (m.mediaType === 'audio') {
                    contenuHTML = `<audio src="${API_URL}${m.mediaUrl}" controls class="chat-voice-player"></audio>${m.texte ? '<br>' + m.texte : ''}`;
                } else if (m.mediaUrl) {
                    contenuHTML = `<img src="${API_URL}${m.mediaUrl}" style="max-width: 200px; border-radius: 8px;"><br>${m.texte || ""}`;
                }

                // --- Bouton de suppression ---
                const btnSupprimer = `<button class="btn-delete-msg" onclick="supprimerMessage('${m._id}')"><i class="fa-solid fa-trash"></i></button>`;

                const div = document.createElement("div");
                div.className = `message-bubble ${estMoi ? 'sent' : 'received'}`;
                div.innerHTML = `${contenuHTML} <span class="msg-timestamp">${heure} ${cocheHTML}</span> ${btnSupprimer}`;
                container.appendChild(div);
            });

            memoireDiscussionState = etatActuel;
            if (forcerScroll) container.scrollTop = container.scrollHeight;
        }

        const chatInputBlock = document.getElementById("chat-input-block");
        const mobLayout = document.getElementById("mobile-messages-layout");
        if (chatInputBlock) chatInputBlock.style.display = "flex";
        if (mobLayout) mobLayout.classList.add("chat-active");
        
        if (socket && forcerScroll) socket.emit('markAsRead', userId);
    }
}

async function envoyerMessage() {
    const input = document.getElementById("message-text");
    if (!input || !input.value.trim() || !chatActifUserId) return;

    if (socket) socket.emit('stopTyping', chatActifUserId);

    const res = await fetchAPI(`/messages/${chatActifUserId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texte: input.value })
    });
    if (res && res.ok) { 
        input.value = ""; 
        chargerDiscussion(chatActifUserId, true); 
        chargerMessagerie(); 
    }
}

// --- GESTION DU PANNEAU DE PARAMÈTRES ---
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

    const picker = document.getElementById('chat-color-picker');
    const bgSelect = document.getElementById('chat-bg-select');
    const toggleEph = document.getElementById('toggle-ephemeral');
    const toggleMuteEl = document.getElementById('toggle-mute');

    if (picker) picker.value = color;
    if (bgSelect) bgSelect.value = bg;
    if (toggleEph) toggleEph.checked = isEphemere;
    if (toggleMuteEl) toggleMuteEl.checked = isMuted;

    appliquerCouleurChat(color);
    appliquerFondChat(bg);
}

// --- FOND D'ÉCRAN PERSONNALISÉ ---
function changerFondChat(typeFond) {
    if (!chatActifUserId) return;
    localStorage.setItem(`chat_bg_${chatActifUserId}`, typeFond);
    appliquerFondChat(typeFond);
}

function appliquerFondChat(typeFond) {
    const container = document.getElementById("messages-history");
    if (!container) return;
    
    container.className = "messages-history-container"; 
    if (typeFond !== 'default') {
        container.classList.add(`chat-bg-${typeFond}`);
    }
}

// --- MESSAGES ÉPHÉMÈRES ---
function toggleEphemere(actif) {
    if (!chatActifUserId) return;
    localStorage.setItem(`chat_ephemere_${chatActifUserId}`, actif);
    afficherToast(actif ? "⏱️ Messages éphémères activés (24h)" : "⏱️ Messages éphémères désactivés");
    if (socket) socket.emit('toggleEphemere', { cibleId: chatActifUserId, actif });
}

// --- MODE SILENCE ---
function toggleMute(actif) {
    if (!chatActifUserId) return;
    localStorage.setItem(`chat_mute_${chatActifUserId}`, actif);
    afficherToast(actif ? "🔇 Discussion en mode silence" : "🔔 Notifications réactivées");
}

// --- VIDER L'HISTORIQUE ---
async function viderHistoriqueChat() {
    if (!chatActifUserId) return;
    if (!confirm("⚠️ Attention : Voulez-vous vraiment supprimer tous les messages de cette conversation pour vous et votre contact ?")) return;

    const res = await fetchAPI(`/messages/clear/${chatActifUserId}`, { method: "DELETE" });
    if (res && res.ok) {
        const hist = document.getElementById("messages-history");
        if (hist) hist.innerHTML = "";
        memoireDiscussionState = "";
        afficherToast("Conversation vidée avec succès");
        toggleChatSettings(); 
    }
}

function fermerChatMobile() {
    chatActifUserId = null; 
    const mobLayout = document.getElementById("mobile-messages-layout");
    if (mobLayout) mobLayout.classList.remove("chat-active");
}

// --- LOGIQUE VOCALE (MICROPHONE) ---
async function demarrerEnregistrementVocal(e) {
    if (e && e.cancelable) e.preventDefault();
    try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(audioStream);
        audioChunks = [];

        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.start();
        
        const recInd = document.getElementById("voice-recording-indicator");
        const msgText = document.getElementById("message-text");
        const btnSend = document.getElementById("btn-send-text");
        const timerEl = document.getElementById("recording-timer");

        if (recInd) recInd.style.display = "flex";
        if (msgText) msgText.style.display = "none";
        if (btnSend) btnSend.style.display = "none";
        
        recordingSeconds = 0;
        if (timerEl) timerEl.innerText = "0:00";
        
        clearInterval(recordingTimer);
        recordingTimer = setInterval(() => {
            recordingSeconds++;
            const mins = Math.floor(recordingSeconds / 60);
            const secs = recordingSeconds % 60;
            if (timerEl) timerEl.innerText = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
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
            if (audioStream) audioStream.getTracks().forEach(track => track.stop());
        };
        mediaRecorder.stop();
    }
    clearInterval(recordingTimer);
}

function annulerEnregistrementVocal() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        fermerIndicateurVocal();
        if (audioStream) audioStream.getTracks().forEach(track => track.stop());
    }
    clearInterval(recordingTimer);
}

function fermerIndicateurVocal() {
    const recInd = document.getElementById("voice-recording-indicator");
    const msgText = document.getElementById("message-text");
    const btnSend = document.getElementById("btn-send-text");
    
    if (recInd) recInd.style.display = "none";
    if (msgText) msgText.style.display = "block";
    if (btnSend) btnSend.style.display = "block";
}

// --- NOTIFICATIONS ---
async function actualiserBadgeNotifications(silencieux) {
    const res = await fetchAPI("/notifications");
    if (res && res.ok) {
        const notifs = await res.json();
        const nonLues = (notifs || []).filter(n => !n.read);
        const b1 = document.getElementById("notif-badge");
        const b2 = document.getElementById("mob-notif-badge");
        const b3 = document.getElementById("top-mob-notif-badge"); 

        if (nonLues.length > 0) {
            if (b1) { b1.innerText = nonLues.length; b1.style.display = "inline-block"; }
            if (b2) { b2.innerText = nonLues.length; b2.style.display = "inline-block"; }
            if (b3) { b3.innerText = nonLues.length; b3.style.display = "inline-block"; }

            if (!silencieux && notifs.length > 0 && notifs[0]._id !== dernierIdNotification) {
                dernierIdNotification = notifs[0]._id;
                afficherToast(`🔔 Nouvelle notification en attente !`);
                if (b1) b1.classList.add("badge-bounce"); 
                if (b2) b2.classList.add("badge-bounce");
                if (b3) b3.classList.add("badge-bounce");
            }
        } else { 
            if (b1) b1.style.display = "none"; 
            if (b2) b2.style.display = "none"; 
            if (b3) b3.style.display = "none"; 
        }
    }
}

async function chargerNotifications() {
    const res = await fetchAPI("/notifications");
    if (res && res.ok) {
        const notifs = await res.json();
        const container = document.getElementById("notifications-container");
        if (!container) return;
        
        container.innerHTML = (notifs || []).length === 0 ? "<p>Aucune alerte.</p>" : "";
        (notifs || []).forEach(n => {
            const div = document.createElement("div");
            div.className = `notif-item ${!n.read ? 'unread':''}`;
            div.innerHTML = `<p><i class="fa-solid fa-bell" style="color:var(--gold);"></i> <strong>@${n.fromPseudo || "Utilisateur"}</strong> a réagi à votre activité. <span style="font-size:11px; color:gray;">${formaterDateRelative(n.date)}</span></p>`;
            container.appendChild(div);
        });
        await fetchAPI("/notifications/read", { method: "POST" });
        
        ["notif-badge", "mob-notif-badge", "top-mob-notif-badge"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = "none";
        });
    }
}

// --- LOGIQUE DES STORIES / STATUTS PRIVÉS ---
async function chargerStatuts() {
    const res = await fetchAPI("/statuses");
    if (!res || !res.ok) return;
    const statuts = await res.json();
    const listContainer = document.getElementById("contacts-statuses-container");
    if (!listContainer) return;
    listContainer.innerHTML = "";

    let mapMembres = {};
    (statuts || []).forEach(s => {
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

function ouvrirModaleCreationStatut() { 
    const el = document.getElementById('create-status-modal');
    if (el) el.style.display = 'flex'; 
}

function fermerModaleCreationStatut() { 
    const el = document.getElementById('create-status-modal');
    const txtInput = document.getElementById('status-text-input');
    if (el) el.style.display = 'none'; 
    if (txtInput) txtInput.value = "";
    retirerMediaStatut();
}

function previsualiserMediaStatut(event) {
    const file = event.target.files[0];
    if (file) {
        fichierStatutSelectionne = file;
        const previewImg = document.getElementById('status-image-preview');
        const previewContainer = document.getElementById('status-media-preview-container');
        if (previewImg) previewImg.src = URL.createObjectURL(file);
        if (previewContainer) previewContainer.style.display = 'block';
    }
}

function retirerMediaStatut() {
    fichierStatutSelectionne = null;
    const fileUpload = document.getElementById('status-file-upload');
    const previewContainer = document.getElementById('status-media-preview-container');
    if (fileUpload) fileUpload.value = "";
    if (previewContainer) previewContainer.style.display = 'none';
}

async function publierStatut() {
    const txtEl = document.getElementById('status-text-input');
    if (!txtEl) return;
    const txt = txtEl.value;
    if (!txt.trim() && !fichierStatutSelectionne) return;

    const formData = new FormData();
    formData.append("texte", txt);
    if (fichierStatutSelectionne) formData.append("statusMedia", fichierStatutSelectionne);

    const res = await fetchAPI("/statuses", { method: "POST", body: formData });
    if (res && res.ok) { 
        afficherToast("Statut partagé !"); 
        fermerModaleCreationStatut(); 
        chargerStatuts(); 
    }
}

function demarrerVisionneuseStatut(statusArray) {
    let index = 0;
    const modal = document.getElementById('view-status-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    async function afficherIndex() {
        if (index >= statusArray.length) { fermerVisionneuseStatut(); return; }
        const s = statusArray[index];
        
        await fetchAPI(`/statuses/${s._id}/read`, { method: "POST" });

        const authorNameEl = document.getElementById('viewer-author-name');
        const authorAvEl = document.getElementById('viewer-author-avatar');
        const statusTimeEl = document.getElementById('viewer-status-time');
        const bodyEl = document.getElementById('viewer-content-area');

        if (authorNameEl) authorNameEl.innerText = `@${s.author}`;
        if (authorAvEl) authorAvEl.src = s.avatarUrl ? `${API_URL}${s.avatarUrl}` : PAR_DEFAUT_AVATAR;
        if (statusTimeEl) statusTimeEl.innerText = formaterDateRelative(s.date);

        if (bodyEl) {
            if (s.type === 'image') {
                bodyEl.innerHTML = `<div style='text-align:center;'><img src="${API_URL}${s.mediaUrl}"><p style='color:white; margin-top:10px; font-size:14px;'>${s.text || ""}</p></div>`;
            } else {
                bodyEl.innerHTML = `<div class="big-text-status">"${s.text || ""}"</div>`;
            }
        }

        const fillBar = document.getElementById('status-progress-bar');
        if (fillBar) {
            fillBar.style.transition = 'none'; 
            fillBar.style.width = '0%';
            setTimeout(() => { 
                fillBar.style.transition = 'width 5000ms linear'; 
                fillBar.style.width = '100%'; 
            }, 50);
        }

        clearTimeout(statusTimerInterval);
        statusTimerInterval = setTimeout(() => { index++; afficherIndex(); }, 5000);
    }
    afficherIndex();
}

function fermerVisionneuseStatut() {
    clearTimeout(statusTimerInterval);
    const modal = document.getElementById('view-status-modal');
    if (modal) modal.style.display = 'none';
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
    const overlay = document.getElementById("mobile-search-overlay");
    const inputEl = document.getElementById("mob-search-input");
    if (overlay) overlay.style.display = "flex";
    if (inputEl) inputEl.focus();
}

function fermerRechercheMobile() {
    const overlay = document.getElementById("mobile-search-overlay");
    const inputEl = document.getElementById("mob-search-input");
    const container = document.getElementById("mob-search-results-container");
    if (overlay) overlay.style.display = "none";
    if (inputEl) inputEl.value = "";
    if (container) container.innerHTML = "";
}

// --- SUPPRESSION DE MESSAGES ---
async function supprimerMessage(messageId) {
    if (!confirm("Voulez-vous vraiment supprimer ce message ?")) return;
    
    const res = await fetchAPI(`/messages/${messageId}`, { method: "DELETE" });
    if (res && res.ok) {
        afficherToast("Message supprimé");
        if (chatActifUserId) chargerDiscussion(chatActifUserId, true); 
    }
}

async function rechercherUtilisateursMobile() {
    const inputEl = document.getElementById("mob-search-input");
    const container = document.getElementById("mob-search-results-container");
    if (!inputEl || !container) return;
    
    const query = inputEl.value.trim();
    if (!query) { container.innerHTML = ""; return; }

    const res = await fetchAPI(`/users/search?q=${encodeURIComponent(query)}`);
    if (!res || !res.ok) return;
    const users = await res.json();
    
    container.innerHTML = (users || []).length === 0 ? "<p style='color:gray; font-size:12px;'>Aucun membre trouvé.</p>" : "";
    
    const fragment = document.createDocumentFragment();
    (users || []).forEach(u => {
        const div = document.createElement("div");
        div.className = "user-result";
        div.style.marginBottom = "8px";
        div.innerHTML = `
            <span>@${u.pseudo}</span>
            <button class="btn-primary" style="padding: 4px 10px; font-size: 11px;">Suivre</button>`;
        const btn = div.querySelector("button");
        if (btn) {
            btn.onclick = () => {
                suivreUtilisateur(u._id);
                fermerRechercheMobile();
            };
        }
        fragment.appendChild(div);
    });
    container.appendChild(fragment);
}