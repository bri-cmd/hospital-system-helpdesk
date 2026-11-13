(function () {
  var container = document.querySelector("[data-toast-container]");
  if (!container) return;

  function titleFor(text) {
    var t = text.toLowerCase();
    if (t.indexOf("approved") > -1) return "Ticket approved";
    if (t.indexOf("assigned") > -1) return "Ticket assigned";
    if (t.indexOf("overdue") > -1 || t.indexOf("pms") > -1) return "PMS overdue";
    if (t.indexOf("status") > -1) return "Status updated";
    if (t.indexOf("message") > -1) return "New message";
    return "New Ticket";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function restyle(toast) {
    if (toast.dataset.restyled) return;
    var link = toast.querySelector("a");
    if (!link) return;
    toast.dataset.restyled = "1";

    var href = link.getAttribute("href") || "#";
    var text = (link.textContent || "").trim();
    var num = text.match(/(?:Ticket-)?(\d{6})/);
    var colon = text.indexOf(":");
    var summary = colon > -1 ? text.slice(colon + 1).trim() : text;

    toast.textContent = "";

    var top = el("div", "toast-top");
    var img = el("img");
    img.src = "/images/logo.png";
    img.alt = "";
    var title = el("strong", "", titleFor(text));
    var time = el("time", "", "just now");
    var close = el("button", "toast-close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    top.appendChild(img);
    top.appendChild(title);
    top.appendChild(time);
    top.appendChild(close);
    toast.appendChild(top);

    if (num) toast.appendChild(el("span", "toast-pill", num[1]));
    toast.appendChild(el("p", "toast-summary", summary));

    var actions = el("div", "toast-actions");
    var view = el("a", "toast-view", "View ticket");
    view.href = href;
    var dismiss = el("button", "toast-dismiss", "Dismiss");
    dismiss.type = "button";
    actions.appendChild(view);
    actions.appendChild(dismiss);
    toast.appendChild(actions);

    var remaining = 8000;
    var started = Date.now();
    var timer = setTimeout(remove, remaining);

    function remove() {
      clearTimeout(timer);
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }
    toast.addEventListener("mouseenter", function () {
      clearTimeout(timer);
      remaining -= Date.now() - started;
    });
    toast.addEventListener("mouseleave", function () {
      started = Date.now();
      timer = setTimeout(remove, Math.max(remaining, 1500));
    });
    close.addEventListener("click", remove);
    dismiss.addEventListener("click", remove);

    while (container.children.length > 3) {
      container.removeChild(container.firstChild);
    }
  }

  new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType === 1 && n.classList.contains("staff-toast")) restyle(n);
      });
    });
  }).observe(container, { childList: true });
})();