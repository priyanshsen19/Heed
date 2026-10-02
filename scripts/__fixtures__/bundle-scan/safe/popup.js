// A representative, harmless bundle: public configuration names are allowed.
const apiBase = "https://api.example.test";
const env = "production"; // VITE_ENV
export function render(el) { el.textContent = "Not connected " + apiBase + " " + env; }
