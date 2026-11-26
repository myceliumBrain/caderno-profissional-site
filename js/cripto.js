// Criptografia do caderno (Web Crypto API — só funciona em https:// ou localhost).
//
// Esquema "envelope":
//   - Uma CHAVE MESTRA aleatória (256 bits) cifra o conteúdo do caderno (AES-GCM).
//   - A chave mestra é guardada várias vezes, cada cópia trancada por uma
//     "fechadura": uma com a SENHA e outra com o CÓDIGO DE RECUPERAÇÃO
//     (chave derivada via PBKDF2-SHA256, 600.000 iterações).
//   - Trocar a senha ou o código só reescreve a fechadura; o conteúdo continua
//     cifrado com a mesma chave mestra.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const ITERACOES = 600000;

export function paraB64(bytes) {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function deB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

const aleatorio = (n) => crypto.getRandomValues(new Uint8Array(n));

async function derivarChave(segredo, sal, iteracoes) {
  const base = await crypto.subtle.importKey("raw", enc.encode(segredo), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: sal, iterations: iteracoes, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function importarChaveMestra(bruta) {
  return crypto.subtle.importKey("raw", bruta, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function novaChaveMestra() {
  return aleatorio(32);
}

export async function criarFechadura(tipo, segredo, chaveMestra) {
  const sal = aleatorio(16);
  const iv = aleatorio(12);
  const kek = await derivarChave(segredo, sal, ITERACOES);
  const dados = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, chaveMestra);
  return { tipo, sal: paraB64(sal), iv: paraB64(iv), iteracoes: ITERACOES, dados: paraB64(dados) };
}

// Lança erro se o segredo estiver errado (o AES-GCM detecta).
export async function abrirFechadura(fechadura, segredo) {
  const kek = await derivarChave(segredo, deB64(fechadura.sal), fechadura.iteracoes);
  const bruta = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64(fechadura.iv) }, kek, deB64(fechadura.dados));
  return new Uint8Array(bruta);
}

export async function cifrar(chaveMestra, objeto) {
  const iv = aleatorio(12);
  const chave = await importarChaveMestra(chaveMestra);
  const dados = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chave, enc.encode(JSON.stringify(objeto)));
  return { iv: paraB64(iv), dados: paraB64(dados) };
}

export async function decifrar(chaveMestra, { iv, dados }) {
  const chave = await importarChaveMestra(chaveMestra);
  const bruto = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64(iv) }, chave, deB64(dados));
  return JSON.parse(dec.decode(bruto));
}

// Código de recuperação: 32 caracteres (160 bits), sem letras ambíguas (I, O, 0, 1).
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function novoCodigoRecuperacao() {
  let s = "";
  for (const x of aleatorio(32)) s += ALFABETO[x & 31];
  return s.match(/.{4}/g).join("-");
}

export function normalizarCodigo(codigo) {
  return codigo.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Arquivos (anexos): devolve iv (12 bytes) + conteúdo cifrado, tudo junto.
export async function cifrarBytes(chaveMestra, bytes) {
  const iv = aleatorio(12);
  const chave = await importarChaveMestra(chaveMestra);
  const dados = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chave, bytes));
  const saida = new Uint8Array(12 + dados.length);
  saida.set(iv);
  saida.set(dados, 12);
  return saida;
}

export async function decifrarBytes(chaveMestra, bytes) {
  const chave = await importarChaveMestra(chaveMestra);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, chave, bytes.subarray(12)));
}
