document.querySelectorAll(".ticket-table tbody tr[data-ticket-url]").forEach((row) => {
  row.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      return;
    }
    window.location.href = row.dataset.ticketUrl;
  });

  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      window.location.href = row.dataset.ticketUrl;
    }
  });
});
