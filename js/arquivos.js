// Arquivos anexados (PDFs, fotos…) dos textos e dos lembretes.
//
// Arquitetura: ARMAZENAMENTO ENDEREÇADO POR CONTEÚDO + COLETA DE LIXO
// "MARCAR E VARRER", o mesmo modelo que o próprio Git usa com seus objetos.
//
//   data/arquivos/<nome>.bin
//
//   - <nome> vem do conteúdo do arquivo (HMAC-SHA256, ver cripto.js). O mesmo
//     PDF anexado em dois textos (ou duas vezes) gera o mesmo nome e é gravado
//     UMA vez só. Não há como duplicar nem dois arquivos disputarem um nome.
//   - O caderno não guarda "contadores" de uso (que podem se perder). Quem
//     decide o que fica é o próprio caderno: um arquivo está em uso se algum
//     texto, entrada, lembrete (inclusive na lixeira) cita o nome dele.
//   - Coleta de lixo: depois de salvar, lista data/arquivos e MARCA os que
//     ninguém cita. Só VARRE (apaga) um arquivo se ele continuar sem uso numa
//     coleta feita pelo menos 24 h depois (como o "prune expiry" do git gc).
//     Esse prazo protege envios em andamento em outro aparelho e o "desfazer".
//   - Tudo é cifrado (AES-GCM) antes de sair do navegador.
//
// data/anexos/<id>.bin é o formato antigo (lembretes): só é lido. Os antigos
// são convertidos para data/arquivos na primeira abertura (ver app.js) e a
// coleta de lixo apaga a cópia antiga depois.

import { cifrarBytes, decifrarBytes, nomeDoConteudo } from "./cripto.js";

export const PASTA_ARQUIVOS = "data/arquivos";
const PASTA_LEGADO = "data/anexos";
export const ARQUIVO_MAX_MB = 25;
const CARENCIA_MS = 24 * 60 * 60 * 1000;
const LS_ORFAOS = "caderno.arquivosSemUso";

const NOME = /^[0-9a-f]{64}$/;
export const ehNome = (x) => typeof x === "string" && NOME.test(x);

export function caminhoDoArquivo(ref) {
  if (ehNome(ref.hash)) return `${PASTA_ARQUIVOS}/${ref.hash}.bin`;
  return `${PASTA_LEGADO}/${ref.id}.bin`;
}

// Nomes em envio agora (ainda não citados no caderno salvo): nunca são varridos.
const emEnvio = new Set();

// Cifra e envia. `jaExistem` = nomes que o caderno já cita (pula o envio).
// Devolve a referência a guardar no caderno.
export async function guardarArquivo({ github, chave }, arquivo, jaExistem = new Set()) {
  if (arquivo.size > ARQUIVO_MAX_MB * 1024 * 1024) throw new Error(`“${arquivo.name}” passa de ${ARQUIVO_MAX_MB} MB.`);
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const hash = await nomeDoConteudo(chave, bytes);
  emEnvio.add(hash);
  try {
    if (!jaExistem.has(hash)) {
      await github.gravarSeNovo(`${PASTA_ARQUIVOS}/${hash}.bin`, await cifrarBytes(chave, bytes), `Caderno: arquivo ${new Date().toISOString()}`);
    }
  } catch (e) {
    emEnvio.delete(hash);
    throw e;
  }
  // Continua protegido até a próxima coleta depois de salvar o caderno.
  return { hash, nome: arquivo.name || "arquivo", tipo: arquivo.type || "application/octet-stream", tamanho: arquivo.size, criadoEm: new Date().toISOString() };
}

export async function lerArquivo({ github, chave }, ref) {
  return decifrarBytes(chave, await github.lerBinario(caminhoDoArquivo(ref)));
}

// MARCAR: tudo o que o caderno cita (texto, HTML, lembretes, lixeira).
// Na dúvida, uma citação a mais só faz um arquivo ficar — nunca sumir.
export function citacoes(...objetos) {
  const nomes = new Set();
  const legados = new Set();
  for (const o of objetos) {
    const json = JSON.stringify(o ?? null);
    for (const m of json.matchAll(/[0-9a-f]{64}/g)) nomes.add(m[0]);
    for (const m of json.matchAll(/anexo-[a-z0-9]+/g)) legados.add(m[0]);
  }
  return { nomes, legados };
}

function lerOrfaos() {
  try { return JSON.parse(localStorage.getItem(LS_ORFAOS) || "{}"); } catch { return {}; }
}

async function varrer(github, pasta, chaveDe, citados, antes, orfaos, agora) {
  const lista = await github.listar(pasta);
  let apagados = 0;
  for (const a of lista) {
    const chave = chaveDe(a.nome.replace(/\.bin$/, ""));
    if (!chave || citados.has(chave) || emEnvio.has(chave)) continue;
    const desde = antes[chave] ?? agora;
    if (agora - desde >= CARENCIA_MS) {
      try {
        await github.apagar(a.caminho, `Caderno: arquivo sem uso apagado ${new Date().toISOString()}`, a.sha);
        apagados++;
        continue;
      } catch { /* fica para a próxima */ }
    }
    orfaos[chave] = desde;
  }
  return { total: lista.length, apagados };
}

// VARRER. `cit` (de citacoes) deve vir do caderno recém-salvo/sincronizado.
// Devolve { total, semUso, apagados }.
export async function coletarLixo({ github }, cit) {
  const antes = lerOrfaos();
  const orfaos = {};
  const agora = Date.now();
  const a = await varrer(github, PASTA_ARQUIVOS, (n) => (ehNome(n) ? n : null), cit.nomes, antes, orfaos, agora);
  const b = await varrer(github, PASTA_LEGADO, (n) => (/^anexo-[a-z0-9]+$/.test(n) ? n : null), cit.legados, antes, orfaos, agora);
  localStorage.setItem(LS_ORFAOS, JSON.stringify(orfaos));
  // Os enviados já estão citados no caderno salvo: não precisam mais de proteção.
  for (const h of [...emEnvio]) if (cit.nomes.has(h)) emEnvio.delete(h);
  return { total: a.total + b.total, semUso: Object.keys(orfaos).length, apagados: a.apagados + b.apagados };
}

export function tamanhoTexto(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}
