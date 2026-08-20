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

