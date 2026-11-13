document.querySelectorAll(".machine-table tbody tr[data-machine-href]").forEach((row) => {
  row.addEventListener("click", (event) => {
    if (event.target.closest("a, button, input, select, textarea")) {
      return;
    }
    window.location.href = row.dataset.machineHref;
  });
});
