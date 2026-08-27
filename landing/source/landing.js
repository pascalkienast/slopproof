// Public landing interactions.
const tabs = [...document.querySelectorAll(".mode-tab")];
const panels = [...document.querySelectorAll(".mode-panel")];

function showMode(mode, shouldScroll = false) {
  tabs.forEach((tab) => {
    const selected = tab.id === `${mode}-tab`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  panels.forEach((panel) => {
    const selected = panel.id === `${mode}-panel`;
    panel.classList.toggle("active", selected);
    panel.hidden = !selected;
  });
  document.querySelectorAll(".check-choice").forEach((choice) => {
    choice.classList.toggle("active", choice.dataset.openMode === mode);
  });
  if (shouldScroll) {
    document
      .querySelector("#product")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => showMode(tab.id.replace("-tab", "")));
  tab.addEventListener("keydown", (event) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      nextIndex = (index + direction + tabs.length) % tabs.length;
    }
    const nextTab = tabs[nextIndex];
    showMode(nextTab.id.replace("-tab", ""));
    nextTab.focus();
  });
});

document.querySelectorAll("[data-open-mode]").forEach((control) => {
  control.addEventListener("click", (event) => {
    const mode = control.dataset.openMode;
    showMode(mode, control.tagName === "BUTTON");
    if (control.tagName === "BUTTON") event.preventDefault();
  });
});

document.querySelectorAll(".hotspot").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".hotspot")
      .forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    document.querySelector("#coach-title").textContent = button.dataset.title;
    document.querySelector("#coach-question").textContent =
      button.dataset.question;
    document.querySelector("#coach-note").textContent = button.dataset.note;
  });
});

const journeyCarousel = document.querySelector(".journey-carousel");

if (journeyCarousel) {
  const journeySlides = [...journeyCarousel.querySelectorAll(".journey-slide")];
  const journeyDots = [...journeyCarousel.querySelectorAll(".journey-dot")];
  let journeyIndex = 0;

  function showJourneyStep(index) {
    journeyIndex = (index + journeySlides.length) % journeySlides.length;
    journeySlides.forEach((slide, slideIndex) => {
      slide.hidden = slideIndex !== journeyIndex;
    });
    journeyDots.forEach((dot, dotIndex) => {
      if (dotIndex === journeyIndex) {
        dot.setAttribute("aria-current", "step");
      } else {
        dot.removeAttribute("aria-current");
      }
    });
  }

  journeyDots.forEach((dot) => {
    dot.addEventListener("click", () => {
      showJourneyStep(Number(dot.dataset.journeyIndex));
    });
  });

  journeyCarousel
    .querySelector('[data-journey-direction="previous"]')
    ?.addEventListener("click", () => showJourneyStep(journeyIndex - 1));
  journeyCarousel
    .querySelector('[data-journey-direction="next"]')
    ?.addEventListener("click", () => showJourneyStep(journeyIndex + 1));

  journeyCarousel.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    showJourneyStep(journeyIndex + (event.key === "ArrowRight" ? 1 : -1));
  });
}

const closedBetaForm = document.querySelector("#closed-beta-form");
const closedBetaStatus = document.querySelector("#closed-beta-status");

function setClosedBetaStatus(message, state = "idle") {
  if (!closedBetaStatus) return;
  closedBetaStatus.textContent = message;
  closedBetaStatus.dataset.state = state;
}

closedBetaForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = closedBetaForm.querySelector('button[type="submit"]');
  const formData = new FormData(closedBetaForm);
  const githubUsername = String(formData.get("githubUsername") ?? "")
    .trim()
    .replace(/^@/u, "");

  if (!submitButton) return;
  submitButton.disabled = true;
  setClosedBetaStatus("Adding your request…");
  try {
    const response = await fetch("/api/public/closed-beta", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        email: String(formData.get("email") ?? "").trim(),
        githubUsername,
        contactConsent: formData.get("contactConsent") === "on",
        website: String(formData.get("website") ?? "").trim(),
      }),
    });

    if (response.status === 202) {
      closedBetaForm.reset();
      setClosedBetaStatus(
        `You're in the queue, @${githubUsername}. We'll email you when a beta slot opens.`,
        "success",
      );
    } else if (response.status === 400) {
      setClosedBetaStatus(
        "Check the email, GitHub username, and consent box, then try again.",
        "error",
      );
    } else if (response.status === 429) {
      setClosedBetaStatus(
        "Too many requests from this connection. Give it a few minutes.",
        "error",
      );
    } else {
      setClosedBetaStatus(
        "The queue is temporarily unavailable. Please try again later.",
        "error",
      );
    }
  } catch {
    setClosedBetaStatus(
      "The queue is temporarily unavailable. Please try again later.",
      "error",
    );
  } finally {
    submitButton.disabled = false;
  }
});
