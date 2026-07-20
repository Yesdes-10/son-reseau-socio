/**
 * JO SOCIO - ENTERPRISE CLIENT ENGINE
 * Architecture orientée services et gestion d'état centralisée.
 */

// ============================================================================
// 1. GESTIONNAIRE D'ÉTAT DU CLIENT (STATE MANAGEMENT)
// ============================================================================
const AppState = {
    apiUrl: window.location.origin,
    defaultAvatar: "https://www.w3schools.com/howto/img_avatar.png",
    token: localStorage.getItem("social_token") || null,
    currentUser: null,
    activeChatUserId: null,
    selectedImageFile: null,
    selectedStatusFile: null,
    cropperInstance: null,
    socket: null,
    typingTimeout: null,
    lastNotificationId: null,
    statusTimer: null,
    
    // Matériel audio
    mediaRecorder: null,
    audioStream: null,
    audioChunks: [],
    recordingTimer: null,
    recordingSeconds: 0
};

// ============================================================================
// 2. INTERCEPTEUR HTTP (API CLIENT)
// ============================================================================
class APIClient {
    static async request(endpoint, options = {}) {
        const headers = { ...options.headers };
        if (AppState.token) {
            headers["Authorization"] = `Bearer ${AppState.token}`;
        }
        if (options.body && !(options.body instanceof FormData)) {
            headers["Content-Type"] = "application/json";
        }

        try {
            const response = await fetch(`${AppState.apiUrl}${endpoint}`, { ...options, headers });
            if (response.status === 401 || response.status === 403) {
                AuthService.logout();
                return null;
            }
            return response;
        } catch (error) {
            console.error(`[API Error] ${endpoint}:`, error);
            UIManager.showToast("Erreur de communication avec le serveur.");
            return null;
        }
    }
}

// ============================================================================
// 3. UTILITAIRES DE SÉCURITÉ ET DE FORMATAGE
// ============================================================================
class SecurityUtils {
    static escapeHTML(str) {
        if (!str) return "";
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    static formatRelativeTime(dateISO) {
        if (!dateISO) return "";
        const diffSeconds = Math.floor((new Date() - new Date(dateISO)) / 1000);
        if (diffSeconds < 60) return "À l'instant";
        if (diffSeconds < 3600) return `Il y a ${Math.floor(diffSeconds / 60)} min`;
        if (diffSeconds < 86400) return `Il y a ${Math.floor(diffSeconds / 3600)} h`;
        return new Date(dateISO).toLocaleDateString();
    }
}

// ============================================================================
// 4. GESTION DU REAL-TIME (WEBSOCKETS)
// ============================================================================
class SocketService {
    static init() {
        if (typeof io === 'undefined' || !AppState.token) return;
        
        AppState.socket = io(AppState.apiUrl, { auth: { token: AppState.token } });
        const { socket } = AppState;

        socket.on('newMessage', (msg) => {
            if (AppState.activeChatUserId === msg.fromId) {
                ChatService.loadConversation(msg.fromId, true);
                socket.emit('markAsRead', msg.fromId);
            } else {
                ChatService.loadContacts();
                NotificationService.updateBadge(false);
                UIManager.showToast("Nouveau message professionnel reçu.");
            }
        });

        socket.on('userTyping', (userId) => {
            if (AppState.activeChatUserId === userId) {
                document.getElementById('typing-indicator')?.classList.remove('is-hidden');
                const history = document.getElementById("messages-history");
                if (history) history.scrollTop = history.scrollHeight;
            }
        });

        socket.on('userStoppedTyping', (userId) => {
            if (AppState.activeChatUserId === userId) {
                document.getElementById('typing-indicator')?.classList.add('is-hidden');
            }
        });

        socket.on('messagesReadBy', (userId) => {
            if (AppState.activeChatUserId === userId) ChatService.loadConversation(userId, false);
        });
    }

    static sendTypingNotice() {
        if (!AppState.activeChatUserId || !AppState.socket) return;
        AppState.socket.emit('typing', AppState.activeChatUserId);
        clearTimeout(AppState.typingTimeout);
        AppState.typingTimeout = setTimeout(() => {
            AppState.socket.emit('stopTyping', AppState.activeChatUserId);
        }, 1500);
    }
}

// ============================================================================
// 5. SERVICES D'AUTHENTIFICATION ET PROFIL
// ============================================================================
class AuthService {
    static async login(pseudo, password) {
        try {
            const res = await fetch(`${AppState.apiUrl}/auth/connexion`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pseudo, password })
            });
            const data = await res.json();
            if (res.ok && data.token) {
                localStorage.setItem("social_token", data.token);
                location.reload();
            } else {
                UIManager.showAuthFeedback(data.erreur || "Identifiants incorrects.", true);
            }
        } catch (error) {
            UIManager.showAuthFeedback("Erreur de connexion au serveur.", true);
        }
    }

    static async register(pseudo, password) {
        try {
            const res = await fetch(`${AppState.apiUrl}/auth/inscription`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pseudo, password })
            });
            const data = await res.json();
            if (res.ok) {
                UIManager.showAuthFeedback("Inscription réussie ! Vous pouvez vous connecter.", false);
            } else {
                UIManager.showAuthFeedback(data.erreur || "Erreur lors de l'inscription.", true);
            }
        } catch (error) {
            UIManager.showAuthFeedback("Erreur réseau.", true);
        }
    }

    static logout() {
        localStorage.removeItem("social_token");
        location.reload();
    }

    static async syncCurrentUserData() {
        const res = await APIClient.request("/users/me");
        if (res && res.ok) {
            const moi = await res.json();
            AppState.currentUser = moi;
            const avatarUrl = moi.avatarUrl ? `${AppState.apiUrl}${moi.avatarUrl}` : AppState.defaultAvatar;
            
            ["sidebar-avatar", "feed-creator-avatar", "my-status-avatar-img"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.src = avatarUrl;
            });
            const pseudoEl = document.getElementById("sidebar-pseudo");
            if (pseudoEl) pseudoEl.innerText = `@${SecurityUtils.escapeHTML(moi.pseudo)}`;
        }
    }
}

class ProfileService {
    static async loadProfile(userId = null) {
        const isMe = !userId || userId === "me";
        const url = isMe ? `/users/me` : `/users/${userId}`;
        const res = await APIClient.request(url);

        if (res && res.ok) {
            const data = await res.json();
            if (data.redirectMe) return this.loadProfile("me");

            document.getElementById("profile-pseudo").innerText = `@${SecurityUtils.escapeHTML(data.pseudo)}`;
            document.getElementById("profile-avatar-img").src = data.avatarUrl ? `${AppState.apiUrl}${data.avatarUrl}` : AppState.defaultAvatar;

            const editLabel = document.getElementById("change-avatar-label");
            const actionBox = document.getElementById("profile-action-container");
            const settingsBox = document.getElementById("profile-settings-container");
            const postsBox = document.getElementById("profile-posts-container");
            
            actionBox.innerHTML = ""; settingsBox.innerHTML = ""; postsBox.innerHTML = "";

            if (isMe) {
                editLabel?.classList.remove("is-hidden");
                const nbPosts = (data.mesPosts || []).length;
                document.getElementById("profile-stats").innerText = `Abonnements : ${data.abonnementsCount || 0} | Publications : ${nbPosts}`;
                
                settingsBox.innerHTML = `
                    <div class="settings-card mt-4">
                        <div class="form-group flex-row">
                            <input type="text" id="input-nouveau-pseudo" class="form-input" placeholder="Nouveau pseudo">
                            <button id="btn-update-pseudo" class="btn btn-secondary">Modifier</button>
                        </div>
                        <button id="btn-delete-account" class="btn btn-danger mt-2">Supprimer le compte</button>
                    </div>`;
                
                if (nbPosts === 0) postsBox.innerHTML = "<p class='empty-state'>Aucune publication pour le moment.</p>";
                data.mesPosts?.forEach(p => postsBox.appendChild(FeedService.createPostElement({...p, auteur: data, estLeMien: true})));
            } else {
                editLabel?.classList.add("is-hidden");
                const nbPosts = (data.posts || []).length;
                document.getElementById("profile-stats").innerText = `Publications : ${data.postsCount || nbPosts}`;
                
                const btnFollow = data.estAbonne 
                    ? `<button class="btn btn-secondary" data-action="unfollow" data-id="${data._id}">Ne plus suivre</button>` 
                    : `<button class="btn btn-primary" data-action="follow" data-id="${data._id}">Suivre</button>`;
                
                actionBox.innerHTML = `${btnFollow} <button class="btn btn-outline" data-action="message" data-id="${data._id}"><i class="fa-solid fa-envelope"></i> Message</button>`;
                
                if (nbPosts === 0) postsBox.innerHTML = "<p class='empty-state'>Ce membre n'a rien publié.</p>";
                data.posts?.forEach(p => postsBox.appendChild(FeedService.createPostElement({...p, auteur: data, estLeMien: false})));
            }
        }
    }
}

// ============================================================================
// 6. SERVICE PUBLICATIONS & FIL D'ACTUALITÉ
// ============================================================================
class FeedService {
    static async loadFeed() {
        const res = await APIClient.request("/feed");
        if (!res || !res.ok) return;
        const posts = await res.json();
        const container = document.getElementById("feed-container");
        if (!container) return;
        
        container.innerHTML = (posts || []).length === 0 ? "<p class='empty-state'>Votre fil est vide. Suivez d'autres professionnels !</p>" : "";
        posts?.forEach(p => container.appendChild(this.createPostElement(p)));
    }

    static async publish() {
        const contentEl = document.getElementById("post-content");
        const contenu = contentEl?.value || "";
        if (!contenu.trim() && !AppState.selectedImageFile) return;

        const formData = new FormData();
        formData.append("contenu", contenu);
        if (AppState.selectedImageFile) formData.append("image", AppState.selectedImageFile);

        const res = await APIClient.request("/posts", { method: "POST", body: formData });
        if (res && res.ok) {
            contentEl.value = "";
            this.clearMediaPreview();
            UIManager.showToast("Publication partagée avec succès.");
            this.loadFeed();
        }
    }

    static clearMediaPreview() {
        AppState.selectedImageFile = null;
        document.getElementById("post-image").value = "";
        document.getElementById("preview-container")?.classList.add("is-hidden");
    }

    static createPostElement(post) {
        const div = document.createElement("article");
        div.className = "post-card";
        const nom = post.auteur ? SecurityUtils.escapeHTML(post.auteur.pseudo) : "Membre Anonyme";
        const av = (post.auteur && post.auteur.avatarUrl) ? `${AppState.apiUrl}${post.auteur.avatarUrl}` : AppState.defaultAvatar;
        
        let mediaHTML = "";
        if (post.imageUrl) {
            mediaHTML = (post.mediaType === 'video' || post.imageUrl.endsWith('.mp4')) 
                ? `<video src="${AppState.apiUrl}${post.imageUrl}" class="post-media" controls></video>`
                : `<img src="${AppState.apiUrl}${post.imageUrl}" class="post-media" alt="Média publication">`;
        }

        let commentsHTML = "";
        post.commentaires?.forEach(c => {
            commentsHTML += `<div class="comment-item"><strong>@${SecurityUtils.escapeHTML(c.auteur || "Anonyme")}</strong> : ${SecurityUtils.escapeHTML(c.texte || "")}</div>`;
        });

        const likesCount = (post.likes || []).length;
        const btnDelete = post.estLeMien ? `<button class="btn-icon text-danger" data-action="delete-post" data-id="${post._id}" aria-label="Supprimer"><i class="fa-solid fa-trash"></i></button>` : "";
        
        // Zéro événement inline (gestion propre par Event Delegation)
        div.innerHTML = `
            <header class="post-header flex-between">
                <div class="user-meta pointer" data-action="view-profile" data-id="${post.auteurId}">
                    <img src="${av}" class="avatar avatar-sm" alt="">
                    <span class="user-name">@${nom}</span>
                </div>
                ${btnDelete}
            </header>
            <div class="post-body">${SecurityUtils.escapeHTML(post.contenu || "")}</div>
            ${mediaHTML}
            <footer class="post-actions">
                <button class="btn-action" data-action="like-post" data-id="${post._id}">
                    <i class="fa-solid fa-heart ${likesCount > 0 ? 'text-danger' : ''}"></i> ${likesCount}
                </button>
            </footer>
            <section class="comments-section">
                <div class="comments-list">${commentsHTML}</div>
                <div class="comment-input-group">
                    <input type="text" class="form-input comment-input" placeholder="Ajouter un commentaire..." data-post-id="${post._id}">
                    <button class="btn btn-secondary btn-sm" data-action="send-comment" data-id="${post._id}">Envoyer</button>
                </div>
            </section>`;
        return div;
    }
}

// ============================================================================
// 7. SERVICE MESSAGERIE ET AUDIO
// ============================================================================
class ChatService {
    static async loadContacts(forceUserId = null) {
        StatusService.loadStatuses();
        const res = await APIClient.request("/messages/contacts");
        if (res && res.ok) {
            const contacts = await res.json();
            const container = document.getElementById("contacts-container");
            if (!container) return;
            container.innerHTML = "";

            contacts?.forEach(c => {
                const av = c.avatarUrl ? `${AppState.apiUrl}${c.avatarUrl}` : AppState.defaultAvatar;
                const snippet = c.dernierMessage ? (c.dernierMessage.length > 25 ? c.dernierMessage.substring(0,25)+"..." : c.dernierMessage) : "Nouvelle conversation";
                
                const div = document.createElement("div");
                div.className = "contact-item";
                div.id = `contact-${c._id}`;
                div.setAttribute("data-action", "open-chat");
                div.setAttribute("data-id", c._id);
                div.innerHTML = `
                    <img src="${av}" class="avatar avatar-sm" alt="">
                    <div class="contact-meta">
                        <span class="contact-name">@${SecurityUtils.escapeHTML(c.pseudo)}</span>
                        <span class="contact-snippet">${SecurityUtils.escapeHTML(snippet)}</span>
                    </div>`;
                container.appendChild(div);
            });
            if (forceUserId) this.loadConversation(forceUserId, true);
        }
    }

    static async loadConversation(userId, forceScroll = false) {
        AppState.activeChatUserId = userId;
        const res = await APIClient.request(`/messages/${userId}`);
        if (res && res.ok) {
            const msgs = await res.json();
            const container = document.getElementById("messages-history");
            if (!container) return;
            
            document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('is-active'));
            const activeItem = document.getElementById(`contact-${userId}`);
            if (activeItem) {
                activeItem.classList.add('is-active');
                document.getElementById("chat-header-text").innerText = activeItem.querySelector('.contact-name').innerText;
                document.getElementById("chat-header-avatar").src = activeItem.querySelector('img').src;
                document.getElementById("chat-header-avatar").classList.remove('is-hidden');
            }

            container.innerHTML = "";
            msgs?.forEach(m => {
                const heure = new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const isMe = m.fromId !== userId;
                
                let checkHTML = "";
                if (isMe) {
                    if (m.status === 'read') checkHTML = `<span class="tick read"><i class="fa-solid fa-check-double"></i></span>`;
                    else if (m.status === 'delivered') checkHTML = `<span class="tick delivered"><i class="fa-solid fa-check-double"></i></span>`;
                    else checkHTML = `<span class="tick"><i class="fa-solid fa-check"></i></span>`;
                }

                let content = SecurityUtils.escapeHTML(m.texte || "");
                if (m.mediaType === 'audio') {
                    content = `<audio src="${AppState.apiUrl}${m.mediaUrl}" controls class="audio-player"></audio>${m.texte ? '<br>' + SecurityUtils.escapeHTML(m.texte) : ''}`;
                } else if (m.mediaUrl) {
                    content = `<img src="${AppState.apiUrl}${m.mediaUrl}" class="chat-media-img" alt=""><br>${SecurityUtils.escapeHTML(m.texte || "")}`;
                }

                const div = document.createElement("div");
                div.className = `message-bubble ${isMe ? 'sent' : 'received'}`;
                div.innerHTML = `${content} <span class="message-meta">${heure} ${checkHTML}</span>`;
                container.appendChild(div);
            });

            document.getElementById("chat-input-block")?.classList.remove("is-hidden");
            document.getElementById("mobile-messages-layout")?.classList.add("chat-active");
            if (forceScroll) container.scrollTop = container.scrollHeight;
            if (AppState.socket && forceScroll) AppState.socket.emit('markAsRead', userId);
        }
    }

    static async sendMessage() {
        const input = document.getElementById("message-text");
        if (!input || !input.value.trim() || !AppState.activeChatUserId) return;

        if (AppState.socket) AppState.socket.emit('stopTyping', AppState.activeChatUserId);

        const res = await APIClient.request(`/messages/${AppState.activeChatUserId}`, {
            method: "POST", body: JSON.stringify({ texte: input.value })
        });
        if (res && res.ok) {
            input.value = "";
            this.loadConversation(AppState.activeChatUserId, true);
            this.loadContacts();
        }
    }

    // Enregistrement vocal optimisé avec Garbage Collection pure[cite: 7]
    static async startVoiceRecording(e) {
        if (e && e.cancelable) e.preventDefault();
        try {
            AppState.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            AppState.mediaRecorder = new MediaRecorder(AppState.audioStream);
            AppState.audioChunks = [];

            AppState.mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) AppState.audioChunks.push(event.data);
            };

            AppState.mediaRecorder.start();
            
            document.getElementById("voice-recording-indicator")?.classList.remove("is-hidden");
            document.getElementById("message-text")?.classList.add("is-hidden");
            document.getElementById("btn-send-text")?.classList.add("is-hidden");
            
            AppState.recordingSeconds = 0;
            const timerEl = document.getElementById("recording-timer");
            if (timerEl) timerEl.innerText = "0:00";
            
            clearInterval(AppState.recordingTimer);
            AppState.recordingTimer = setInterval(() => {
                AppState.recordingSeconds++;
                const mins = Math.floor(AppState.recordingSeconds / 60);
                const secs = AppState.recordingSeconds % 60;
                if (timerEl) timerEl.innerText = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
            }, 1000);
        } catch (err) {
            UIManager.showToast("Accès au microphone refusé.");
        }
    }

    static stopAndSendVoice(e) {
        if (e && e.cancelable) e.preventDefault();
        const { mediaRecorder, audioStream, audioChunks, activeChatUserId } = AppState;
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.onstop = async () => {
                this.closeVoiceUI();
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                if (audioBlob.size > 0 && activeChatUserId) {
                    const formData = new FormData();
                    formData.append("media", audioBlob, "vocal.webm");
                    const res = await APIClient.request(`/messages/${activeChatUserId}`, {
                        method: "POST", body: formData
                    });
                    if (res && res.ok) {
                        this.loadConversation(activeChatUserId, true);
                        this.loadContacts();
                    }
                }
                // Nettoyage strict des pistes mémoire[cite: 7]
                if (audioStream) {
                    audioStream.getTracks().forEach(track => track.stop());
                    AppState.audioStream = null;
                }
            };
            mediaRecorder.stop();
        }
        clearInterval(AppState.recordingTimer);
    }

    static cancelVoiceRecording() {
        if (AppState.mediaRecorder && AppState.mediaRecorder.state === "recording") {
            AppState.mediaRecorder.stop();
            this.closeVoiceUI();
            if (AppState.audioStream) {
                AppState.audioStream.getTracks().forEach(track => track.stop());
                AppState.audioStream = null;
            }
        }
        clearInterval(AppState.recordingTimer);
    }

    static closeVoiceUI() {
        document.getElementById("voice-recording-indicator")?.classList.add("is-hidden");
        document.getElementById("message-text")?.classList.remove("is-hidden");
        document.getElementById("btn-send-text")?.classList.remove("is-hidden");
    }
}

// ============================================================================
// 8. SERVICE STATUTS ET NOTIFICATIONS
// ============================================================================
class StatusService {
    static async loadStatuses() {
        const res = await APIClient.request("/statuses");
        if (!res || !res.ok) return;
        const statuts = await res.json();
        const listContainer = document.getElementById("contacts-statuses-container");
        if (!listContainer) return;
        listContainer.innerHTML = "";

        const mapMembres = {};
        statuts?.forEach(s => {
            if (!mapMembres[s.userId]) mapMembres[s.userId] = { pseudo: s.author, avatar: s.avatarUrl, list: [] };
            mapMembres[s.userId].list.push(s);
        });

        Object.keys(mapMembres).forEach(uId => {
            const m = mapMembres[uId];
            const aLuTout = m.list.every(s => s.read);
            const av = m.avatar ? `${AppState.apiUrl}${m.avatar}` : AppState.defaultAvatar;

            const div = document.createElement("div");
            div.className = `story-item ${aLuTout ? '' : 'unread'}`;
            div.setAttribute("data-action", "view-status");
            div.setAttribute("data-id", uId);
            div.innerHTML = `
                <div class="story-avatar"><img src="${av}" alt=""></div>
                <span class="story-label">@${SecurityUtils.escapeHTML(m.pseudo)}</span>`;
            
            div.addEventListener('click', () => this.startViewer(m.list));
            listContainer.appendChild(div);
        });
    }

    static async publish() {
        const txtEl = document.getElementById('status-text-input');
        const txt = txtEl?.value || "";
        if (!txt.trim() && !AppState.selectedStatusFile) return;

        const formData = new FormData();
        formData.append("texte", txt);
        if (AppState.selectedStatusFile) formData.append("statusMedia", AppState.selectedStatusFile);

        const res = await APIClient.request("/statuses", { method: "POST", body: formData });
        if (res && res.ok) {
            UIManager.showToast("Statut diffusé !");
            document.getElementById('create-status-modal')?.classList.add('is-hidden');
            txtEl.value = "";
            this.loadStatuses();
        }
    }

    static startViewer(statusArray) {
        let index = 0;
        const modal = document.getElementById('view-status-modal');
        if (!modal) return;
        modal.classList.remove('is-hidden');

        const displayNext = async () => {
            if (index >= statusArray.length) {
                modal.classList.add('is-hidden');
                clearTimeout(AppState.statusTimer);
                this.loadStatuses();
                return;
            }
            const s = statusArray[index];
            await APIClient.request(`/statuses/${s._id}/read`, { method: "POST" });

            document.getElementById('viewer-author-name').innerText = `@${SecurityUtils.escapeHTML(s.author)}`;
            document.getElementById('viewer-author-avatar').src = s.avatarUrl ? `${AppState.apiUrl}${s.avatarUrl}` : AppState.defaultAvatar;
            document.getElementById('viewer-status-time').innerText = SecurityUtils.formatRelativeTime(s.date);

            const bodyEl = document.getElementById('viewer-content-area');
            if (bodyEl) {
                bodyEl.innerHTML = s.type === 'image'
                    ? `<div class="text-center"><img src="${AppState.apiUrl}${s.mediaUrl}" class="viewer-img" alt=""><p class="viewer-caption">${SecurityUtils.escapeHTML(s.text || "")}</p></div>`
                    : `<div class="viewer-text-only">"${SecurityUtils.escapeHTML(s.text || "")}"</div>`;
            }

            const fillBar = document.getElementById('status-progress-bar');
            if (fillBar) {
                fillBar.style.transition = 'none'; fillBar.style.width = '0%';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        fillBar.style.transition = 'width 5000ms linear';
                        fillBar.style.width = '100%';
                    });
                });
            }
            clearTimeout(AppState.statusTimer);
            AppState.statusTimer = setTimeout(() => { index++; displayNext(); }, 5000);
        };
        displayNext();
    }
}

class NotificationService {
    static async updateBadge(silent = false) {
        const res = await APIClient.request("/notifications");
        if (res && res.ok) {
            const notifs = await res.json();
            const nonLues = (notifs || []).filter(n => !n.read);
            
            ["notif-badge", "mob-notif-badge", "top-mob-notif-badge"].forEach(id => {
                const badge = document.getElementById(id);
                if (!badge) return;
                if (nonLues.length > 0) {
                    badge.innerText = nonLues.length;
                    badge.classList.remove("is-hidden");
                } else {
                    badge.classList.add("is-hidden");
                }
            });

            if (!silent && notifs.length > 0 && notifs[0]._id !== AppState.lastNotificationId) {
                AppState.lastNotificationId = notifs[0]._id;
                UIManager.showToast("🔔 Nouvelle interaction sur votre profil.");
            }
        }
    }

    static async loadNotifications() {
        const res = await APIClient.request("/notifications");
        if (res && res.ok) {
            const notifs = await res.json();
            const container = document.getElementById("notifications-container");
            if (!container) return;
            
            container.innerHTML = (notifs || []).length === 0 ? "<p class='empty-state'>Aucune alerte récente.</p>" : "";
            notifs?.forEach(n => {
                const div = document.createElement("div");
                div.className = `notif-card ${!n.read ? 'unread' : ''}`;
                div.innerHTML = `<i class="fa-solid fa-bell text-primary"></i> <div><strong>@${SecurityUtils.escapeHTML(n.fromPseudo || "Membre")}</strong> a réagi à votre activité. <div class="notif-time">${SecurityUtils.formatRelativeTime(n.date)}</div></div>`;
                container.appendChild(div);
            });
            await APIClient.request("/notifications/read", { method: "POST" });
            this.updateBadge(true);
        }
    }
}

// ============================================================================
// 9. GESTIONNAIRE D'INTERFACE ET DÉLÉGATION D'ÉVÉNEMENTS (UI MANAGER)
// ============================================================================
class UIManager {
    static navigateTo(section, targetId = null) {
        document.querySelectorAll('.menu-item, .mobile-nav-item').forEach(el => el.classList.remove('is-active'));
        document.querySelectorAll('.view-section').forEach(el => el.classList.add('is-hidden'));

        if (section === 'messages') {
            document.getElementById('mobile-messages-layout')?.classList.remove('chat-active');
            AppState.activeChatUserId = null;
        }

        document.getElementById(`nav-${section}`)?.classList.add('is-active');
        document.getElementById(`mob-nav-${section}`)?.classList.add('is-active');

        const view = document.getElementById(`${section === 'profil' ? 'profile' : section}-section`);
        view?.classList.remove('is-hidden');

        if (section === 'feed') FeedService.loadFeed();
        else if (section === 'profil') ProfileService.loadProfile(targetId);
        else if (section === 'messages') ChatService.loadContacts(targetId);
        else if (section === 'notifications') NotificationService.loadNotifications();
    }

    static showToast(message) {
        const container = document.getElementById("toast-container");
        if (!container) return;
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add("fade-out");
            setTimeout(() => toast.remove(), 400);
        }, 3000);
    }

    static showAuthFeedback(msg, isError) {
        const el = document.getElementById("auth-message");
        if (!el) return;
        el.textContent = msg;
        el.className = `auth-feedback ${isError ? 'text-danger' : 'text-success'}`;
    }

    // Délégation d'événements globale : Remplace tous les onclick inline !
    static initEventListeners() {
        // Authentification
        document.getElementById("auth-form")?.addEventListener("submit", (e) => {
            e.preventDefault();
            AuthService.login(document.getElementById("pseudo").value.trim(), document.getElementById("password").value.trim());
        });
        document.getElementById("btn-register")?.addEventListener("click", () => {
            AuthService.register(document.getElementById("pseudo").value.trim(), document.getElementById("password").value.trim());
        });

        // Navigation Menu
        document.addEventListener("click", (e) => {
            const trigger = e.target.closest("[data-action]");
            if (!trigger) return;

            const action = trigger.getAttribute("data-action");
            const id = trigger.getAttribute("data-id");
            const target = trigger.getAttribute("data-target");

            switch (action) {
                case "nav":
                    e.preventDefault();
                    this.navigateTo(target);
                    break;
                case "open-chat":
                    ChatService.loadConversation(id, true);
                    break;
                case "view-profile":
                    this.navigateTo('profil', id);
                    break;
                case "like-post":
                    APIClient.request(`/posts/${id}/like`, { method: "POST" }).then(() => FeedService.loadFeed());
                    break;
                case "delete-post":
                    if (confirm("Supprimer cette publication ?")) {
                        APIClient.request(`/posts/${id}`, { method: "DELETE" }).then(() => FeedService.loadFeed());
                    }
                    break;
                case "follow":
                    APIClient.request(`/users/${id}/follow`, { method: "POST" }).then(() => ProfileService.loadProfile(id));
                    break;
                case "unfollow":
                    APIClient.request(`/users/${id}/unfollow`, { method: "POST" }).then(() => ProfileService.loadProfile(id));
                    break;
                case "message":
                    this.navigateTo('messages', id);
                    break;
                case "send-comment":
                    const input = document.querySelector(`.comment-input[data-post-id="${id}"]`);
                    if (input && input.value.trim()) {
                        APIClient.request(`/posts/${id}/comment`, {
                            method: "POST", body: JSON.stringify({ texte: input.value })
                        }).then(() => FeedService.loadFeed());
                    }
                    break;
            }
        });

        // Boutons isolés sans inline script
        document.getElementById("btn-logout")?.addEventListener("click", AuthService.logout);
        document.getElementById("btn-mob-logout")?.addEventListener("click", AuthService.logout);
        document.getElementById("btn-publish")?.addEventListener("click", () => FeedService.publish());
        document.getElementById("btn-send-text")?.addEventListener("click", () => ChatService.sendMessage());
        
        document.getElementById("message-text")?.addEventListener("input", () => SocketService.sendTypingNotice());
        document.getElementById("message-text")?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") ChatService.sendMessage();
        });

        // Gestion Médias & Modales
        document.getElementById("post-image")?.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (file) {
                AppState.selectedImageFile = file;
                const container = document.getElementById("preview-container");
                const img = document.getElementById("image-preview");
                const vid = document.getElementById("video-preview");
                container?.classList.remove("is-hidden");
                if (file.type.startsWith("video/")) {
                    img.classList.add("is-hidden");
                    vid.src = URL.createObjectURL(file); vid.classList.remove("is-hidden");
                } else {
                    vid.classList.add("is-hidden");
                    img.src = URL.createObjectURL(file); img.classList.remove("is-hidden");
                }
            }
        });
        document.getElementById("btn-cancel-media")?.addEventListener("click", () => FeedService.clearMediaPreview());

        // Statuts Modales
        document.getElementById("btn-open-status-modal")?.addEventListener("click", () => {
            document.getElementById('create-status-modal')?.classList.remove('is-hidden');
        });
        document.querySelectorAll(".btn-close-status-modal").forEach(btn => {
            btn.addEventListener("click", () => {
                document.getElementById('create-status-modal')?.classList.add('is-hidden');
                AppState.selectedStatusFile = null;
            });
        });
        document.getElementById("btn-publish-status")?.addEventListener("click", () => StatusService.publish());
        document.getElementById("btn-close-viewer")?.addEventListener("click", () => {
            document.getElementById('view-status-modal')?.classList.add('is-hidden');
            clearTimeout(AppState.statusTimer);
        });

        // Enregistrement vocal
        const micBtn = document.getElementById("btn-hold-mic");
        if (micBtn) {
            micBtn.addEventListener("mousedown", (e) => ChatService.startVoiceRecording(e));
            micBtn.addEventListener("mouseup", (e) => ChatService.stopAndSendVoice(e));
            micBtn.addEventListener("mouseleave", () => ChatService.cancelVoiceRecording());
            micBtn.addEventListener("touchstart", (e) => ChatService.startVoiceRecording(e));
            micBtn.addEventListener("touchend", (e) => ChatService.stopAndSendVoice(e));
        }
    }
}

// ============================================================================
// 10. INITIALISATION DE L'APPLICATION (BOOTSTRAP)
// ============================================================================
window.addEventListener("DOMContentLoaded", () => {
    UIManager.initEventListeners();

    if (AppState.token) {
        document.getElementById("auth-screen")?.classList.add("is-hidden");
        document.getElementById("main-screen")?.classList.remove("is-hidden");

        AuthService.syncCurrentUserData();
        UIManager.navigateTo('feed');
        NotificationService.updateBadge(true);
        SocketService.init();

        // Installation Service Worker pour PWA[cite: 8]
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(err => console.warn("PWA ServiceWorker echec:", err));
        }
    }
});