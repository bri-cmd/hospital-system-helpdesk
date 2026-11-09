(() => {
  const form = document.getElementById("ticket-form");
  if (!form) {
    return;
  }

  const summary = form.elements.summary;
  const hospital = form.elements.hospitalId;
  const details = form.elements.details;
  const submit = document.getElementById("create-ticket");

  function updateFormState() {
    const fields = [
      { input: summary, error: document.getElementById("summary-error"), message: "Issue Summary is required." },
      { input: hospital, error: document.getElementById("hospital-error"), message: "Please select a hospital." },
      { input: details, error: document.getElementById("details-error"), message: "Details are required." }
    ];

    fields.forEach(({ input, error, message }) => {
      const missing = !input.value.trim();
      const invalid = missing && input.dataset.touched === "true";
      input.setAttribute("aria-invalid", String(invalid));
      error.textContent = missing && input.dataset.touched === "true" ? message : "";
    });

    submit.disabled = fields.some(({ input }) => !input.value.trim());
  }

  [summary, hospital, details].forEach((input) => {
    input.addEventListener("input", updateFormState);
    input.addEventListener("change", updateFormState);
    input.addEventListener("blur", () => {
      input.dataset.touched = "true";
      updateFormState();
    });
  });

  form.addEventListener("submit", (event) => {
    updateFormState();
    if (!form.checkValidity()) {
      event.preventDefault();
      [summary, hospital, details].forEach((input) => {
        input.dataset.touched = "true";
      });
      updateFormState();
    }
  });

  updateFormState();
})();
