// ============================================================================
// app.js – Router & Navigation
// ============================================================================
import { renderStart } from "./pages/start.js";
import { renderDay } from "./pages/day.js";
import { renderAdmin } from "./pages/admin.js";
import { renderChecklist } from "./pages/checklist.js";

const outlet = document.getElementById("outlet");
const navLinks = document.querySelectorAll(".nav-link");

function navigate(hash) {
  location.hash = "#/" + hash;
}

function currentRoute() {
  return (location.hash || "#/").slice(2); // strip "#/"
}

function setActiveNav(route) {
  const top = route.split("/")[0];
  navLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.route === top || (top === "" && link.dataset.route === "start") || (top === "day" && link.dataset.route === "start"));
  });
}

function render() {
  const route = currentRoute();
  outlet.innerHTML = "";
  setActiveNav(route);

  if (route === "" || route === "start") {
    outlet.appendChild(renderStart(navigate));
  } else if (route.startsWith("day/")) {
    const id = route.slice(4);
    outlet.appendChild(renderDay(id, navigate));
  } else if (route.startsWith("admin")) {
    outlet.appendChild(renderAdmin(navigate));
  } else if (route === "checklist") {
    outlet.appendChild(renderChecklist(navigate));
  } else {
    outlet.appendChild(renderStart(navigate));
  }
  window.scrollTo(0, 0);
}

navLinks.forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigate(link.dataset.route === "start" ? "" : link.dataset.route);
  });
});

window.addEventListener("hashchange", render);
render();
