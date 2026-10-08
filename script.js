const menuBtn = document.getElementById("menuBtn");
const nav = document.getElementById("nav");

function setMenu(open) {
    nav.classList.toggle("active", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.textContent = open ? "✕" : "☰";
}

menuBtn.addEventListener("click", () => {
    setMenu(!nav.classList.contains("active"));
});

document.querySelectorAll("nav a").forEach(link => {
    link.addEventListener("click", () => setMenu(false));
});

document.addEventListener("keydown", e => {
    if (e.key === "Escape" && nav.classList.contains("active")) {
        setMenu(false);
        menuBtn.focus();
    }
});

document.getElementById("year").textContent = new Date().getFullYear();

/* Highlight the nav link of the section currently in view (homepage only) */
const sections = document.querySelectorAll("main section[id]");

if ("IntersectionObserver" in window && sections.length) {
    const links = new Map(
        [...document.querySelectorAll('nav a[href^="#"]')].map(a => [a.getAttribute("href").slice(1), a])
    );

    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const link = links.get(entry.target.id);
            if (!link || link.classList.contains("nav-contact")) return;
            if (entry.isIntersecting) {
                links.forEach(l => l.classList.remove("current"));
                link.classList.add("current");
            }
        });
    }, { rootMargin: "-45% 0px -50% 0px" });

    sections.forEach(s => observer.observe(s));
}
