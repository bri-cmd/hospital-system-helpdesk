const editModal = document.querySelector("[data-machine-edit-modal]");

if (editModal) {
  const openButton = document.querySelector("[data-open-machine-edit]");
  const closeButtons = editModal.querySelectorAll("[data-close-machine-edit]");

  const openModal = () => {
    editModal.hidden = false;
    document.body.classList.add("machine-edit-open");
    editModal.querySelector("input, select, textarea")?.focus();
  };

  const closeModal = () => {
    editModal.hidden = true;
    document.body.classList.remove("machine-edit-open");
    openButton?.focus();
  };

  openButton?.addEventListener("click", openModal);
  closeButtons.forEach((button) => button.addEventListener("click", closeModal));
  editModal.addEventListener("click", (event) => {
    if (event.target === editModal) {
      closeModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !editModal.hidden) {
      closeModal();
    }
  });

  if (editModal.dataset.open === "true") {
    openModal();
  }
}
