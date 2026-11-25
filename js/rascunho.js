// Cópia de segurança no navegador (localStorage), para nada se perder se a
// aba fechar ou a internet cair antes de o GitHub receber as alterações.
//
// - O conteúdo é guardado CIFRADO com a mesma chave do caderno: quem abrir o
//   navegador sem a senha não consegue ler.
// - A posição (pasta/texto abertos, rolagem) é guardada à parte, sem conteúdo.

import { cifrar, decifrar } from "./cripto.js";

const RASCUNHO = "caderno.rascunho";
const POSICAO = "caderno.posicao";

export async function guardarRascunho(chave, dados) {
  try {
    const cifrado = await cifrar(chave, { dados, guardadoEm: new Date().toISOString() });
    localStorage.setItem(RASCUNHO, JSON.stringify(cifrado));
    return true;
  } catch {
    return false;
  }
}

// null se não houver rascunho (ou se ele for de outra chave/caderno).
export async function lerRascunho(chave) {
  try {
    const s = localStorage.getItem(RASCUNHO);
    if (!s) return null;
    return await decifrar(chave, JSON.parse(s));
  } catch {
    return null;
  }
}

export function apagarRascunho() {
  try { localStorage.removeItem(RASCUNHO); } catch {}
}

export function guardarPosicao(posicao) {
  try { localStorage.setItem(POSICAO, JSON.stringify({ ...posicao, quando: Date.now() })); } catch {}
}

export function lerPosicao() {
  try { return JSON.parse(localStorage.getItem(POSICAO) || "null"); } catch { return null; }
}
