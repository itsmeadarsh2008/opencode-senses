const card = document.getElementById("card");
const phone = document.getElementById("phone");
const wallpaper = document.getElementById("wallpaper");
const bgToggle = document.getElementById("bgToggle");

bgToggle.addEventListener("click", () => {
  const flat = phone.classList.toggle("flat");
  bgToggle.setAttribute("aria-pressed", String(flat));
});

if (!matchMedia("(pointer: coarse)").matches) {
  phone.addEventListener("pointermove", (e) => {
    const r = phone.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    const y = ((e.clientY - r.top) / r.height - 0.5) * 2;

    card.style.setProperty("--rx", `${(-y * 1.6).toFixed(2)}deg`);
    card.style.setProperty("--ry", `${(x * 1.8).toFixed(2)}deg`);
    card.style.setProperty("--mx", `${((x + 1) / 2) * 100}%`);
    card.style.setProperty("--my", `${((y + 1) / 2) * 100}%`);

    wallpaper.style.transform = `scale(1.06) translate(${(-x * 1.2).toFixed(2)}%, ${(-y * 1.2).toFixed(2)}%)`;
  });

  phone.addEventListener("pointerleave", () => {
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
    card.style.setProperty("--mx", "30%");
    card.style.setProperty("--my", "0%");
    wallpaper.style.transform = "";
  });
}