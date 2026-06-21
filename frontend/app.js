const API_URL = window.location.origin;
const PAR_DEFAUT_AVATAR = "https://www.w3schools.com/howto/img_avatar.png";
let fichierImageSelectionne = null; 
let chatActifUserId = null; 
let cropperInstance = null;
let dernierIdNotification = null;

// --- UTILITAIRES UX ---
function formaterDateRelative(dateISO) {
    if (!dateISO) return "";
    const date = new Date(dateISO);
    const maintenant = new Date();
    const diffSecondes = Math.floor((maintenant - date) / 1000);

    if (diffSecondes < 60) return "À l'instant";
    if (diffSecondes < 3600) return `Il y a ${Math.floor(diffSecondes / 60)} min`;
    if (diffSecondes < 86400) return `Il y a ${Math.floor(diffSecondes / 3600)} h`;
    return `Le ${date.toLocaleDateString()}`;
}

function afficherToast(message) {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 500); 
    }, 3000);
}

window.onload = () => {
    const token = localStorage.getItem("social_token");
    if (token) {
        afficherEcranPrincipal();
        mettreAjourAvatarsEtInfosEnCochiffre();
        naviguerVers('feed');
        
        actualiserBadgeNotifications(true);
        
        setInterval(() => {
            actualiserBadgeNotifications(false);
        }, 5000);
    }
};

// --- GESTION DES IMAGES, VIDÉOS ET AVATARS ---
async function mettreAjourAvatarsEtInfosEnCochiffre() {
    const token = localStorage.getItem("social_token");
    if (!token) return;
    const res = await fetch(`${API_URL}/users/me`, { headers: { "Authorization": `Bearer ${token}` } });
    if (res.ok) {
        const moi = await res.json();
        const avatarComplet = moi.avatarUrl ? `${API_URL}${moi.avatarUrl}` : PAR_DEFAUT_AVATAR;
        document.getElementById("sidebar-avatar").src = avatarComplet;
        document.getElementById("feed-creator-avatar").src = avatarComplet;
        document.getElementById("sidebar-pseudo").innerText = "@" + moi.pseudo;
    }
}

function ouvrirRecadrageAvatar(event) {
    const fichier = event.target.files[0];
    if (!fichier) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const imageElement = document.getElementById("image-to-crop");
        imageElement.src = e.target.result;
        document.getElementById("crop-modal").style.display = "flex";
        if (cropperInstance) cropperInstance.destroy();
        cropperInstance = new Cropper(imageElement, {
            aspectRatio: 1, viewMode: 1, background: false, movable: true, zoomable: true, rotatable: false, scalable: false
        });
    };
    reader.readAsDataURL(fichier);
}

function fermerModaleRecadrage() {
    document.getElementById("crop-modal").style.display = "none";
    document.getElementById("avatar-file-input").value = "";
    if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
}

function sauvegarderAvatarRecadre() {
    if (!cropperInstance) return;
    cropperInstance.getCroppedCanvas({ width: 200, height: 200 }).toBlob(async (blob) => {
        const token = localStorage.getItem("social_token");
        const formData = new FormData();
        formData.append("avatar", blob, "avatar.jpg");
        const res = await fetch(`${API_URL}/users/me/avatar`, { method: "POST", headers: { "Authorization": `Bearer ${token}` }, body: formData });
        if (res.ok) {
            afficherToast("Votre photo de profil a été mise à jour !");
            fermerModaleRecadrage();
            mettreAjourAvatarsEtInfosEnCochiffre();
            chargerProfil("me"); 
        } else { afficherToast("Erreur lors du chargement de l'image."); }
    }, "image/jpeg");
}

function previsualiserImage(event) {
    const fichier = event.target.files[0];
    if (fichier) {
        fichierImageSelectionne = fichier;
        const reader = new FileReader();
        const imgPreview = document.getElementById("image-preview");
        const videoPreview = document.getElementById("video-preview");

        reader.onload = function(e) {
            document.getElementById("preview-container").style.display = "block";
            if (fichier.type.startsWith("video/")) {
                imgPreview.style.display = "none";
                videoPreview.src = e.target.result;
                videoPreview.style.display = "block";
            } else {
                videoPreview.style.display = "none";
                imgPreview.src = e.target.result;
                imgPreview.style.display = "block";
            }
        }
        reader.readAsDataURL(fichier);
    }
}

function annulerImage() {
    fichierImageSelectionne = null;
    document.getElementById("post-image").value = "";
    document.getElementById("preview-container").style.display = "none";
    document.getElementById("image-preview").src = "";
    document.getElementById("video-preview").src = "";
}

// --- AUTHENTIFICATION ---
async function inscrire() {
    const pseudo = document.getElementById("pseudo").value;
    const password = document.getElementById("password").value;
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
        document.getElementById("auth-message").innerText = data.erreur || "Erreur.";
    }
}

async function connecter() {
    const pseudo = document.getElementById("pseudo").value;
    const password = document.getElementById("password").value;
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
        document.getElementById("auth-message").innerText = data.erreur || "Identifiants incorrects.";
    }
}

function deconnecter() {
    localStorage.removeItem("social_token");
    location.reload();
}

function afficherEcranPrincipal() {
    document.getElementById("auth-screen").style.display = "none";
    document.getElementById("main-screen").style.display = "block";
}

function naviguerVers(section, targetId = null) {
    // Retirer 'active' des menus Bureau
    document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
    // Retirer 'active' des menus Mobile
    document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));
    
    document.getElementById('feed-section').style.display = "none";
    document.getElementById('profile-section').style.display = "none";
    document.getElementById('messages-section').style.display = "none";
    document.getElementById('notifications-section').style.display = "none";

    // Si on navigue vers la messagerie, on s'assure d'afficher la liste des contacts sur mobile
    if (section === 'messages') {
        document.getElementById('mobile-messages-layout').classList.remove('chat-active');
        chatActifUserId = null;
    }

    if (section === 'feed') {
        document.getElementById('nav-feed').classList.add('active');
        document.getElementById('mob-nav-feed').classList.add('active');
        document.getElementById('feed-section').style.display = "block";
        chargerFeed();
    } else if (section === 'profil') {
        document.getElementById('nav-profil').classList.add('active');
        document.getElementById('mob-nav-profil').classList.add('active');
        document.getElementById('profile-section').style.display = "block";
        chargerProfil(targetId);
    } else if (section === 'messages') {
        document.getElementById('nav-messages').classList.add('active');
        document.getElementById('mob-nav-messages').classList.add('active');
        document.getElementById('messages-section').style.display = "block";
        chargerMessagerie(targetId);
    } else if (section === 'notifications') {
        document.getElementById('nav-notifications').classList.add('active');
        document.getElementById('mob-nav-notifications').classList.add('active');
        document.getElementById('notifications-section').style.display = "block";
        chargerNotifications();
    }
}

// --- GESTION COMPTE ---
async function modifierMonPseudo() {
    const nouveauPseudo = document.getElementById('input-nouveau-pseudo').value;
    const token = localStorage.getItem("social_token");
    if (!nouveauPseudo) return afficherToast("Veuillez entrer un pseudo valide.");

    const res = await fetch(`${API_URL}/users/me/pseudo`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ nouveauPseudo })
    });
    const data = await res.json();
    if (res.ok) {
        afficherToast("Votre pseudo a été mis à jour !");
        document.getElementById('input-nouveau-pseudo').value = "";
        mettreAjourAvatarsEtInfosEnCochiffre();
        chargerProfil("me"); 
    } else { afficherToast("Erreur : " + data.erreur); }
}

async function supprimerMonCompte() {
    if (!confirm("Attention ! Cette action est irréversible. Voulez-vous vraiment supprimer votre compte ?")) return;
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/users/me`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
        afficherToast("Compte supprimé avec succès.");
        setTimeout(() => { deconnecter(); }, 1500);
    } else {
        const data = await res.json();
        afficherToast("Erreur : " + data.erreur);
    }
}

// --- NOTIFICATIONS ---
async function actualiserBadgeNotifications(silencieux = false) {
    const token = localStorage.getItem("social_token");
    if (!token) return;
    
    try {
        const res = await fetch(`${API_URL}/notifications`, { headers: { "Authorization": `Bearer ${token}` } });
        if (res.ok) {
            const notifs = await res.json();
            const nonLues = notifs.filter(n => !n.read);
            
            // Cible les 2 badges (Bureau et Mobile)
            const badge = document.getElementById("notif-badge");
            const badgeMob = document.getElementById("mob-notif-badge");
            
            if (nonLues.length > 0) {
                badge.innerText = nonLues.length;
                badgeMob.innerText = nonLues.length;
                badge.style.display = "inline-block";
                badgeMob.style.display = "inline-block";
                
                if (!silencieux && notifs.length > 0) {
                    const derniereAlerte = notifs[0];
                    if (derniereAlerte.id !== dernierIdNotification && !derniereAlerte.read) {
                        dernierIdNotification = derniereAlerte.id;
                        
                        const actionText = derniereAlerte.type === 'like' ? 'liké' : 'commenté';
                        afficherToast(`🔔 @${derniereAlerte.fromPseudo} a ${actionText} votre publication !`);
                        
                        badge.classList.remove("badge-bounce");
                        badgeMob.classList.remove("badge-bounce");
                        void badge.offsetWidth;
                        badge.classList.add("badge-bounce");
                        badgeMob.classList.add("badge-bounce");
                    }
                }
            } else { 
                badge.style.display = "none"; 
                badgeMob.style.display = "none"; 
            }

            if (notifs.length > 0) {
                dernierIdNotification = notifs[0].id;
            }
        }
    } catch (erreur) {
        console.error("Erreur d'interrogation des notifications :", erreur);
    }
}

async function chargerNotifications() {
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/notifications`, { headers: { "Authorization": `Bearer ${token}` } });
    if (res.ok) {
        const notifs = await res.json();
        const container = document.getElementById("notifications-container");
        container.innerHTML = "";

        if (notifs.length === 0) {
            container.innerHTML = "<p style='color: var(--text-muted);'>Aucune notification pour le moment.</p>";
        } else {
            notifs.forEach(n => {
                const dateRelative = formaterDateRelative(n.date);
                const div = document.createElement("div");
                div.className = `notif-item ${!n.read ? 'unread' : ''}`;
                div.innerHTML = `<p style="margin:0;"><i class="fa-solid ${n.type === 'like' ? 'fa-heart' : 'fa-comment'}" style="color: ${n.type === 'like' ? 'var(--danger)' : 'var(--gold)'}; margin-right: 10px;"></i> <strong>@${n.fromPseudo}</strong> a ${n.type === 'like' ? 'liké' : 'commenté'} votre publication. <span style="font-size: 11px; color: var(--text-muted); margin-left: 10px;">${dateRelative}</span></p>`;
                container.appendChild(div);
            });
        }
        
        await fetch(`${API_URL}/notifications/read`, { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
        document.getElementById("notif-badge").style.display = "none";
        document.getElementById("mob-notif-badge").style.display = "none";
    }
}

// --- MESSAGERIE PRIVÉE ET ADAPTATION MOBILE ---
async function chargerMessagerie(forceUserChatId = null) {
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/messages/contacts`, { headers: { "Authorization": `Bearer ${token}` } });
    if (res.ok) {
        const contacts = await res.json();
        const container = document.getElementById("contacts-container");
        container.innerHTML = "";

        contacts.forEach(c => {
            const avatarContact = c.avatarUrl ? `${API_URL}${c.avatarUrl}` : PAR_DEFAUT_AVATAR;
            const div = document.createElement("div");
            div.className = "contact-item";
            div.id = `contact-${c._id}`;
            div.innerHTML = `<img src="${avatarContact}" class="avatar-round-mini" style="width:30px; height:30px;"> <span>@${c.pseudo}</span>`;
            div.onclick = () => chargerDiscussion(c._id, true);
            container.appendChild(div);
        });

        if (forceUserChatId) chargerDiscussion(forceUserChatId, true);
        else if (chatActifUserId) chargerDiscussion(chatActifUserId, false);
    }
}

async function chargerDiscussion(userId, forcerScroll = true) {
    chatActifUserId = userId;
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/messages/${userId}`, { headers: { "Authorization": `Bearer ${token}` } });
    
    if (res.ok) {
        const msgs = await res.json();
        const container = document.getElementById("messages-history");
        
        document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
        const elActif = document.getElementById(`contact-${userId}`);
        if (elActif) {
            elActif.classList.add('active');
            document.getElementById("chat-header-text").innerText = `Discussion avec ${elActif.querySelector('span').innerText}`;
        }

        container.innerHTML = "";
        msgs.forEach(m => {
            const div = document.createElement("div");
            div.className = `message-bubble ${m.fromId === userId ? 'received' : 'sent'}`;
            div.innerText = m.texte;
            container.appendChild(div);
        });

        document.getElementById("chat-input-block").style.display = "flex";
        
        // ADAPTATION MOBILE : Activer la vue du chat
        document.getElementById("mobile-messages-layout").classList.add("chat-active");
        
        if (forcerScroll) container.scrollTop = container.scrollHeight;
    }
}

// Fonction pour le bouton retour sur mobile
function fermerChatMobile() {
    chatActifUserId = null;
    document.getElementById("mobile-messages-layout").classList.remove("chat-active");
}

async function envoyerMessage() {
    const input = document.getElementById("message-text");
    const texte = input.value;
    if (!texte.trim() || !chatActifUserId) return;

    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/messages/${chatActifUserId}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ texte })
    });
    if (res.ok) {
        input.value = ""; 
        chargerDiscussion(chatActifUserId, true);
    }
}

// --- PUBLICATIONS ---
async function publier() {
    const contenu = document.getElementById("post-content").value;
    const token = localStorage.getItem("social_token");

    if (!contenu.trim() && !fichierImageSelectionne) return;

    const formData = new FormData();
    formData.append("contenu", contenu);
    if (fichierImageSelectionne) formData.append("image", fichierImageSelectionne);

    await fetch(`${API_URL}/posts`, { method: "POST", headers: { "Authorization": `Bearer ${token}` }, body: formData });
    document.getElementById("post-content").value = ""; 
    annulerImage();
    afficherToast("Post publié !");
    chargerFeed();
}

async function chargerFeed() {
    const token = localStorage.getItem("social_token");
    const feedContainer = document.getElementById("feed-container");
    const res = await fetch(`${API_URL}/feed`, { headers: { "Authorization": `Bearer ${token}` } });
    const posts = await res.json();
    feedContainer.innerHTML = ""; 

    if (posts.length === 0) {
        feedContainer.innerHTML = "<p style='color: var(--text-muted);'>Aucun post à afficher. Suivez des amis !</p>";
        return;
    }
    posts.forEach(post => feedContainer.appendChild(creerElementPost(post)));
}

async function chargerProfil(userId = null) {
    const token = localStorage.getItem("social_token");
    const estMonProfil = !userId || userId === "me";
    const url = estMonProfil ? `${API_URL}/users/me` : `${API_URL}/users/${userId}`;
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });

    if (res.ok) {
        const data = await res.json();
        if (data.redirectMe) return chargerProfil("me");

        document.getElementById("profile-pseudo").innerText = "@" + data.pseudo;
        const imageProfilCible = data.avatarUrl ? `${API_URL}${data.avatarUrl}` : PAR_DEFAUT_AVATAR;
        document.getElementById("profile-avatar-img").src = imageProfilCible;

        const labelBoutonModif = document.getElementById("change-avatar-label");
        const actionContainer = document.getElementById("profile-action-container");
        const settingsContainer = document.getElementById("profile-settings-container");
        const container = document.getElementById("profile-posts-container");
        
        actionContainer.innerHTML = ""; settingsContainer.innerHTML = ""; container.innerHTML = "";

        if (estMonProfil) {
            labelBoutonModif.style.display = "flex"; 
            document.getElementById("profile-stats").innerText = `Abonnements : ${data.abonnementsCount} | Publications : ${data.mesPosts.length}`;
            settingsContainer.innerHTML = `
                <div style="margin-top: 20px; border-top: 1px solid var(--border-color); padding-top: 15px;">
                    <h4 style="margin-bottom: 10px; font-weight: 500;">Gestion du compte</h4>
                    <div style="display: flex; justify-content: center; gap: 10px; margin-bottom: 15px;">
                        <input type="text" id="input-nouveau-pseudo" placeholder="Nouveau pseudo" style="width: auto;">
                        <button class="btn-secondary" onclick="modifierMonPseudo()">Changer</button>
                    </div>
                    <button onclick="supprimerMonCompte()" style="background-color: var(--danger); color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer;">Supprimer mon compte</button>
                </div>
            `;
            if (data.mesPosts.length === 0) {
                container.innerHTML = "<p style='color: var(--text-muted);'>Vous n'avez rien publié pour le moment.</p>";
                return;
            }
            data.mesPosts.forEach(post => container.appendChild(creerElementPost({...post, auteur: { pseudo: data.pseudo, avatarUrl: data.avatarUrl }, estLeMien: true})));
        } else {
            labelBoutonModif.style.display = "none"; 
            document.getElementById("profile-stats").innerText = `Publications : ${data.postsCount}`;
            let boutonFollow = data.estAbonne 
                ? `<button class="btn-secondary" onclick="desuivreUtilisateur('${data._id}')">Ne plus suivre</button>`
                : `<button class="btn-primary" onclick="suivreUtilisateur('${data._id}')">Suivre</button>`;
            
            actionContainer.innerHTML = `<div style="display: flex; justify-content: center; gap: 10px;">${boutonFollow}<button class="btn-primary" onclick="naviguerVers('messages', '${data._id}')"><i class="fa-solid fa-envelope"></i> Message</button></div>`;

            if (data.posts.length === 0) {
                container.innerHTML = "<p style='color: var(--text-muted);'>Cet utilisateur n'a encore rien publié.</p>";
                return;
            }
            data.posts.forEach(post => container.appendChild(creerElementPost({...post, auteur: { pseudo: data.pseudo, avatarUrl: data.avatarUrl }, estLeMien: false})));
        }
    }
}

function creerElementPost(post) {
    const div = document.createElement("div");
    div.className = "post";
    const nomAuteur = post.auteur ? post.auteur.pseudo : "Inconnu";
    const avatarAuteur = (post.auteur && post.auteur.avatarUrl) ? `${API_URL}${post.auteur.avatarUrl}` : PAR_DEFAUT_AVATAR;
    const dateRelative = formaterDateRelative(post.date);
    
    let baliseMedia = "";
    if (post.imageUrl) {
        if (post.mediaType === 'video' || post.imageUrl.endsWith('.mp4') || post.imageUrl.endsWith('.webm')) {
            baliseMedia = `<video src="${API_URL}${post.imageUrl}" class="post-video" controls></video>`;
        } else {
            baliseMedia = `<img src="${API_URL}${post.imageUrl}" class="post-img" alt="Image">`;
        }
    }

    let commentairesHTML = "";
    if (post.commentaires && post.commentaires.length > 0) {
        post.commentaires.forEach(c => {
            const dateCommentaire = formaterDateRelative(c.dateCreation);
            commentairesHTML += `<div class="comment"><strong>@${c.auteur}</strong> <span style="font-size: 11px; color: var(--text-muted); margin-left: 5px;">${dateCommentaire}</span><br> ${c.texte}</div>`;
        });
    }

    let boutonSupprimer = post.estLeMien ? `<button class="btn-action" style="color: var(--danger); border-color: var(--danger);" onclick="supprimerPost('${post._id}')"><i class="fa-solid fa-trash"></i></button>` : "";
    let listeLikes = post.likes || [];

    div.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div class="post-author" onclick="naviguerVers('profil', '${post.auteurId}')" style="cursor: pointer; display: inline-flex; align-items: center;">
                <img src="${avatarAuteur}" class="avatar-round-mini">
                <div style="margin-left:8px; display: flex; flex-direction: column;">
                    <span style="text-decoration: underline;">@${nomAuteur}</span>
                    <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">${dateRelative}</span>
                </div>
            </div>
            ${boutonSupprimer}
        </div>
        <div class="post-content" style="margin-top: 15px;">${post.contenu}</div>
        ${baliseMedia}
        
        <div class="post-actions-bar">
            <button class="btn-action" onclick="liker('${post._id}')"><i class="fa-solid fa-heart" style="color: ${listeLikes.length > 0 ? 'var(--danger)' : ''}"></i> ${listeLikes.length}</button>
        </div>

        <div class="comments-section">
            <div id="comments-list-${post._id}">${commentairesHTML}</div>
            <div class="add-comment">
                <input type="text" id="input-comment-${post._id}" placeholder="Écrire un commentaire...">
                <button class="btn-action" onclick="ajouterCommentaire('${post._id}')">Envoyer</button>
            </div>
        </div>
    `;
    return div;
}

async function liker(postId) {
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/posts/${postId}/like`, { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
    if (res.ok) {
        if (document.getElementById('feed-section').style.display === 'block') chargerFeed();
        else chargerProfil();
    }
}

async function ajouterCommentaire(postId) {
    const token = localStorage.getItem("social_token");
    const inputChamp = document.getElementById(`input-comment-${postId}`);
    const texte = inputChamp.value;
    if (!texte.trim()) return;

    const res = await fetch(`${API_URL}/posts/${postId}/comment`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ texte })
    });
    if (res.ok) {
        inputChamp.value = ""; 
        afficherToast("Commentaire ajouté !");
        if (document.getElementById('feed-section').style.display === 'block') chargerFeed();
        else chargerProfil();
    }
}

async function supprimerPost(postId) {
    if (!confirm("Supprimer définitivement ce post ?")) return;
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/posts/${postId}`, { method: "DELETE", headers: { "Authorization": `Bearer ${token}` } });
    if (res.ok) {
        afficherToast("Post supprimé.");
        if (document.getElementById('feed-section').style.display === 'block') chargerFeed();
        else chargerProfil();
    }
}

async function rechercherUtilisateurs() {
    const query = document.getElementById("search-username").value;
    const token = localStorage.getItem("social_token");
    if (!query.trim()) return;

    const res = await fetch(`${API_URL}/users/search?q=${query}`, { headers: { "Authorization": `Bearer ${token}` } });
    const utilisateurs = await res.json();
    const resultsContainer = document.getElementById("search-results");
    resultsContainer.innerHTML = ""; 

    if (utilisateurs.length === 0) {
        resultsContainer.innerHTML = "<p style='color: gray; font-size: 13px; margin-top: 10px;'>Aucun résultat.</p>";
        return;
    }

    utilisateurs.forEach(user => {
        const div = document.createElement("div");
        div.className = "user-result";
        div.innerHTML = `<span><strong>@${user.pseudo}</strong></span><button class="btn-primary" style="padding: 5px 10px; font-size:12px;" onclick="suivreUtilisateur('${user._id}')">Suivre</button>`;
        resultsContainer.appendChild(div);
    });
}

async function suivreUtilisateur(userId) {
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/users/${userId}/follow`, { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
    const data = await res.json();
    afficherToast(data.message || data.erreur);
    document.getElementById("search-results").innerHTML = ""; 
    document.getElementById("search-username").value = "";
    chargerProfil(userId);
}

async function desuivreUtilisateur(userId) {
    const token = localStorage.getItem("social_token");
    const res = await fetch(`${API_URL}/users/${userId}/unfollow`, { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
    if (res.ok) {
        afficherToast("Abonnement annulé.");
        chargerProfil(userId);
    }
}