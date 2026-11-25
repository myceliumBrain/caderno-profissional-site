// Pequenas funções usadas em vários módulos.

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const agora = () => new Date().toISOString();
export const novoId = (prefixo) => `${prefixo}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const dois = (n) => String(n).padStart(2, "0");

export function dataISO(d = new Date()) {
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

export function horaISO(d = new Date()) {
  return `${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

export function dataLonga(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  const s = new Date(a, m - 1, d).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function dataCurta(iso) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

// "hoje, 14:32" · "ontem, 09:10" · "3 de nov." · "3 de nov. de 2025"
export function quando(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(Date.now() - 864e5);
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === hoje.toDateString()) return `hoje, ${hora}`;
  if (d.toDateString() === ontem.toDateString()) return `ontem, ${hora}`;
  return d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: d.getFullYear() === hoje.getFullYear() ? undefined : "numeric" });
}

export function semAcento(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Texto corrido de um trecho HTML (para busca e resumos).
export function textoDeHtml(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/h\d|\/li|\/tr|\/td|\/th)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

export function nomeDeArquivo(titulo) {
  const base = semAcento(titulo || "documento").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return base || "documento";
}

export function baixarArquivo(nome, conteudo, tipo) {
  const blob = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: nome });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
