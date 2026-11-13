const topbar = document.querySelector("[data-staff-topbar]");

if (topbar) {
  const csrfToken = topbar.dataset.csrfToken;
  const userId = topbar.dataset.userId;
  const profileMenu = topbar.querySelector("[data-profile-menu]");
  const profileToggle = topbar.querySelector("[data-profile-toggle]");
  const profilePopover = topbar.querySelector("[data-profile-popover]");
  const notificationMenu = topbar.querySelector(".notification-menu");
  const photoModal = topbar.querySelector("[data-avatar-modal]");
  const passwordModal = topbar.querySelector("[data-password-modal]");
  const toastContainer = topbar.querySelector("[data-toast-container]");
  const countBadge = topbar.querySelector("[data-notification-count]");
  const notificationList = topbar.querySelector("[data-notification-list]");
  const emptyState = topbar.querySelector("[data-notification-empty]");
  const soundToggle = topbar.querySelector("[data-notification-sound]");
  const soundState = topbar.querySelector("[data-sound-state]");
  const lastSeenKey = `hs-notifications-last-seen:${userId}`;
  const soundKey = "hs-notification-sound";
  let lastSeenId = Number(localStorage.getItem(lastSeenKey));
  if (!Number.isSafeInteger(lastSeenId) || lastSeenId < 0) {
    lastSeenId = Number(topbar.dataset.notificationMaxId) || 0;
    localStorage.setItem(lastSeenKey, String(lastSeenId));
  }

  const setNotificationCount = (count) => {
    countBadge.textContent = count > 99 ? "99+" : String(count);
    countBadge.hidden = count < 1;
    notificationMenu.querySelector("summary").setAttribute("aria-label", `Notifications: ${count} unread`);
  };

  const openNotification = async (event) => {
    const link = event.target.closest('a[href^="/staff/notifications/"][href$="/open"]');
    if (!link || !topbar.contains(link)) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try {
      const response = await fetch(link.href, {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
        credentials: "same-origin"
      });
      if (!response.ok || new URL(response.url).origin !== window.location.origin) {
        console.error("Unable to open notification:", response.status);
        return;
      }
      window.location.assign(response.url);
    } catch (error) {
      console.error("Unable to open notification:", error);
    }
  };
  topbar.addEventListener("click", openNotification);

  const relativeTime = (value) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds} sec ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  };

  const updateTimes = () => {
    topbar.querySelectorAll("[data-notification-time]").forEach((time) => {
      time.textContent = relativeTime(time.dateTime);
    });
  };

  const addNotificationRow = (notification) => {
    if ([...notificationList.children].some((item) =>
      item.dataset.notificationId === String(notification.id))) return;
    const item = document.createElement("li");
    item.className = notification.is_read ? "" : "unread";
    item.dataset.notificationId = notification.id;
    const link = document.createElement("a");
    link.href = notification.link.startsWith("/") && !notification.link.startsWith("//")
      ? notification.link
      : "/staff/dashboard";
    const message = document.createElement("span");
    message.className = "notification-message";
    message.textContent = notification.message;
    const time = document.createElement("time");
    time.dataset.notificationTime = "";
    time.dateTime = new Date(notification.created_at).toISOString();
    time.textContent = relativeTime(notification.created_at);
    const dot = document.createElement("span");
    dot.className = "notification-unread-dot";
    dot.setAttribute("aria-label", "Unread");
    dot.hidden = Boolean(notification.is_read);
    link.append(message, time, dot);
    item.append(link);
    notificationList.prepend(item);
    while (notificationList.children.length > 30) notificationList.lastElementChild.remove();
    emptyState.hidden = notificationList.children.length > 0;
  };

  let audioContext = null;
  let audioUnlocked = false;
  const unlockAudio = () => {
    if (audioUnlocked) return;
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return;
    audioContext = audioContext || new AudioContextConstructor();
    audioContext.resume()
      .then(() => { audioUnlocked = true; })
      .catch((error) => console.error("Unable to enable notification audio:", error));
  };
  document.addEventListener("click", unlockAudio, { once: true });
  document.addEventListener("keydown", unlockAudio, { once: true });

  const playNotificationSound = () => {
    if (!audioUnlocked || !audioContext || soundToggle.checked === false) return;
    const start = audioContext.currentTime;
    [880, 1174].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const toneStart = start + index * 0.13;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(0.12, toneStart + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.11);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneStart + 0.12);
    });
  };

  const showToast = (notification) => {
    const toast = document.createElement("div");
    toast.className = "staff-toast";
    const link = document.createElement("a");
    link.href = notification.link.startsWith("/") && !notification.link.startsWith("//")
      ? notification.link
      : "/staff/dashboard";
    link.textContent = notification.message;
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close notification");
    close.textContent = "×";
    close.addEventListener("click", () => toast.remove());
    toast.append(link, close);
    toastContainer.append(toast);
    window.setTimeout(() => toast.remove(), 6000);
    playNotificationSound();
  };

  const updateAvatar = (avatarUrl) => {
    topbar.querySelectorAll(".user-summary, .profile-identity").forEach((container) => {
      const oldAvatar = container.querySelector(".user-avatar");
      if (!oldAvatar) return;
      if (avatarUrl) {
        const image = document.createElement("img");
        image.className = "user-avatar user-avatar-photo";
        image.src = avatarUrl;
        image.alt = "";
        oldAvatar.replaceWith(image);
      } else {
        const initial = document.createElement("span");
        initial.className = "user-avatar";
        initial.setAttribute("aria-hidden", "true");
        initial.textContent = topbar.querySelector(".user-name")?.textContent.trim().slice(0, 1).toUpperCase() || "";
        oldAvatar.replaceWith(initial);
      }
    });
    const preview = topbar.querySelector("[data-avatar-preview]");
    const previewInitial = topbar.querySelector("[data-avatar-initial]");
    if (avatarUrl) {
      preview.src = avatarUrl;
      preview.hidden = false;
      if (previewInitial) previewInitial.hidden = true;
    } else {
      if (preview) preview.hidden = true;
      if (previewInitial) previewInitial.hidden = false;
    }
  };

  const openModal = (modal) => {
    modal.hidden = false;
    profilePopover.hidden = true;
    profileToggle.setAttribute("aria-expanded", "false");
    modal.querySelector("input:not([type=hidden]), button")?.focus();
  };
  const closeModal = (modal) => {
    modal.hidden = true;
    modal.querySelectorAll("[data-profile-error], [data-avatar-error], [data-password-error], [data-password-success]").forEach((node) => {
      node.hidden = true;
    });
  };

  profileToggle.addEventListener("click", () => {
    const open = profilePopover.hidden;
    profilePopover.hidden = !open;
    profileToggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => {
    if (!profileMenu.contains(event.target)) {
      profilePopover.hidden = true;
      profileToggle.setAttribute("aria-expanded", "false");
    }
    if (!notificationMenu.contains(event.target)) notificationMenu.open = false;
  });

  const openAvatarButton = topbar.querySelector("[data-open-avatar-modal]");
  const openPasswordButton = topbar.querySelector("[data-open-password-modal]");
  openAvatarButton.addEventListener("click", () => openModal(photoModal));
  openPasswordButton.addEventListener("click", () => openModal(passwordModal));
  topbar.querySelectorAll("[data-close-profile-modal]").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.closest(".profile-modal")));
  });
  [photoModal, passwordModal].forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      profilePopover.hidden = true;
      profileToggle.setAttribute("aria-expanded", "false");
      [photoModal, passwordModal].forEach((modal) => { modal.hidden = true; });
      notificationMenu.open = false;
    }
  });

  const avatarFile = topbar.querySelector("[data-avatar-file]");
  const avatarPreview = topbar.querySelector("[data-avatar-preview]");
  const avatarInitial = topbar.querySelector("[data-avatar-initial]");
  const avatarError = topbar.querySelector("[data-avatar-error]");
  const removeAvatarValue = topbar.querySelector("[data-remove-avatar-value]");
  avatarFile.addEventListener("change", () => {
    removeAvatarValue.value = "0";
    avatarError.hidden = true;
    const file = avatarFile.files[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      avatarFile.value = "";
      avatarError.textContent = file.size > 2 * 1024 * 1024
        ? "Photo must be 2 MB or smaller."
        : "Choose a JPG, PNG, or WebP photo.";
      avatarError.hidden = false;
      return;
    }
    avatarPreview.src = URL.createObjectURL(file);
    avatarPreview.hidden = false;
    if (avatarInitial) avatarInitial.hidden = true;
  });

  const submitAvatar = async (removePhoto) => {
    const form = topbar.querySelector("[data-avatar-form]");
    const errorNode = topbar.querySelector("[data-avatar-error]");
    removeAvatarValue.value = removePhoto ? "1" : "0";
    errorNode.hidden = true;
    const response = await fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { "X-CSRF-Token": csrfToken },
      credentials: "same-origin"
    });
    const result = await response.json();
    if (!response.ok) {
      errorNode.textContent = result.error || "Unable to update photo.";
      errorNode.hidden = false;
      return;
    }
    updateAvatar(result.avatarUrl);
    avatarFile.value = "";
    removeAvatarValue.value = "0";
    closeModal(photoModal);
  };

  topbar.querySelector("[data-avatar-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    submitAvatar(false).catch(() => {
      avatarError.textContent = "Unable to update photo. Please try again.";
      avatarError.hidden = false;
    });
  });
  topbar.querySelector("[data-remove-avatar]").addEventListener("click", () => {
    submitAvatar(true).catch(() => {
      avatarError.textContent = "Unable to remove photo. Please try again.";
      avatarError.hidden = false;
    });
  });

  const passwordForm = topbar.querySelector("[data-password-form]");
  const passwordError = topbar.querySelector("[data-password-error]");
  const passwordSuccess = topbar.querySelector("[data-password-success]");
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    passwordError.hidden = true;
    passwordSuccess.hidden = true;
    try {
      const response = await fetch(passwordForm.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(passwordForm)),
        headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "same-origin"
      });
      const result = await response.json();
      if (!response.ok) {
        passwordError.textContent = result.error || "Unable to change password.";
        passwordError.hidden = false;
        return;
      }
      passwordForm.reset();
      passwordSuccess.textContent = result.message;
      passwordSuccess.hidden = false;
    } catch {
      passwordError.textContent = "Unable to change password. Please try again.";
      passwordError.hidden = false;
    }
  });

  topbar.querySelector("[data-mark-notifications-read]").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const response = await fetch(event.currentTarget.action, {
        method: "POST",
        body: new FormData(event.currentTarget),
        headers: { "X-CSRF-Token": csrfToken },
        credentials: "same-origin"
      });
      if (!response.ok) return;
      setNotificationCount(0);
      notificationList.querySelectorAll("li").forEach((item) => {
        item.classList.remove("unread");
        item.querySelector(".notification-unread-dot").hidden = true;
      });
    } catch (error) {
      console.error("Unable to mark notifications as read:", error);
    }
  });

  const soundPreference = localStorage.getItem(soundKey);
  soundToggle.checked = soundPreference !== "off";
  soundState.textContent = soundToggle.checked ? "On" : "Off";
  soundToggle.addEventListener("change", () => {
    localStorage.setItem(soundKey, soundToggle.checked ? "on" : "off");
    soundState.textContent = soundToggle.checked ? "On" : "Off";
  });

  const pollNotifications = async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const response = await fetch(`/staff/notifications/poll?since=${lastSeenId}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) return;
      const result = await response.json();
      setNotificationCount(Number(result.count) || 0);
      for (const notification of result.items) {
        addNotificationRow(notification);
        if (!notification.is_read) showToast(notification);
        lastSeenId = Math.max(lastSeenId, Number(notification.id));
      }
      if (result.items.length) localStorage.setItem(lastSeenKey, String(lastSeenId));
      updateTimes();
    } catch (error) {
      console.error("Unable to poll notifications:", error);
    }
  };

  setNotificationCount(Number(topbar.dataset.unreadCount) || 0);
  updateTimes();
  window.setInterval(pollNotifications, 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pollNotifications();
  });
}
