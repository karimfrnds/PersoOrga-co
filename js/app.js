// ============================================================================
// app.js – Router & Navigation
// ============================================================================
import { renderKiosk } from "./pages/kiosk.js";
import { renderDay } from "./pages/day.js";
import { renderReservations } from "./pages/reservations.js";
import { renderAdmin } from "./pages/admin.js";
import { maybeRunDailyBackup } from "./backup.js";

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
    outlet.appendChild(renderKiosk(navigate));
  } else if (route.startsWith("day/")) {
    const id = route.slice(4);
    outlet.appendChild(renderDay(id, navigate));
  } else if (route === "reservierungen") {
    outlet.appendChild(renderReservations());
  } else if (route.startsWith("admin")) {
    outlet.appendChild(renderAdmin(navigate));
  } else {
    outlet.appendChild(renderKiosk(navigate));
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
maybeRunDailyBackup(); // still im Hintergrund, blockiert das Rendern nicht
