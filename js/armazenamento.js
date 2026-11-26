// Leitura e gravação dos arquivos data/*.json no GitHub (commit direto pela API).

import { paraB64, deB64 } from "./cripto.js";
import { CONFIG } from "./config.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ErroConflito extends Error {}
export class ErroAcesso extends Error {}

const urlConteudo = (caminho) => `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${caminho}`;

// Lê um arquivo sem token (antes do login). Usa a API pública do GitHub, que
// já traz a versão mais nova (o GitHub Pages demora ~1 min para atualizar);
// se a API falhar (ex.: limite de 60 consultas/hora), usa o arquivo publicado
// junto com o site. null = o arquivo ainda não existe.
export async function lerPublico(caminho) {
  let r;
  try {
    r = await fetch(`https://api.github.com${urlConteudo(caminho)}?ref=${encodeURIComponent(CONFIG.branch)}`, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch { r = null; }
  if (r?.status === 404) return null;
  if (r?.ok) {
    const meta = await r.json();
    return JSON.parse(dec.decode(deB64(meta.content.replace(/\s/g, ""))));
  }
  const local = await fetch(caminho, { cache: "no-store" });
  if (local.status === 404) return null;
  if (!local.ok) throw new Error(`Não consegui ler ${caminho} (HTTP ${local.status}).`);
  return local.json();
}

export class GitHub {
  constructor(token) {
    this.token = token;
  }

  async api(caminho, opcoes = {}) {
    const r = await fetch(`https://api.github.com${caminho}`, {
      ...opcoes,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opcoes.headers || {}),
      },
    });
    if (r.status === 401) throw new ErroAcesso("O GitHub recusou o token (inválido, expirado ou revogado).");
    return r;
  }

  // Confere se o token enxerga o repositório e pode gravar nele.
  async validar() {
    const r = await this.api(`/repos/${CONFIG.owner}/${CONFIG.repo}`);
    if (r.status === 404) throw new Error(`O token não tem acesso ao repositório ${CONFIG.owner}/${CONFIG.repo}.`);
    if (!r.ok) throw new Error(`Erro do GitHub ao validar o token (HTTP ${r.status}).`);
    const info = await r.json();
    if (info.permissions && !info.permissions.push) {
      throw new Error("O token não tem permissão de escrita. Use “Contents: Read and write”.");
    }
  }

  // Devolve { json, sha } ou null se o arquivo não existir.
  async ler(caminho) {
    const r = await this.api(`${urlConteudo(caminho)}?ref=${encodeURIComponent(CONFIG.branch)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Erro do GitHub ao ler ${caminho} (HTTP ${r.status}).`);
    const meta = await r.json();
    let b64 = meta.content;
    if (!b64) {
      // Arquivos acima de 1 MB vêm sem conteúdo: busca pelo blob.
      const rb = await this.api(`/repos/${CONFIG.owner}/${CONFIG.repo}/git/blobs/${meta.sha}`);
      if (!rb.ok) throw new Error(`Erro do GitHub ao ler ${caminho} (HTTP ${rb.status}).`);
      b64 = (await rb.json()).content;
    }
    return { json: JSON.parse(dec.decode(deB64(b64.replace(/\s/g, "")))), sha: meta.sha };
  }

  // Grava e devolve o novo sha. Lança ErroConflito se o arquivo mudou desde `sha`.
  async gravar(caminho, objeto, sha, mensagem) {
    const corpo = {
      message: mensagem,
      content: paraB64(enc.encode(JSON.stringify(objeto, null, 1) + "\n")),
      branch: CONFIG.branch,
    };
    if (sha) corpo.sha = sha;
    const r = await this.api(urlConteudo(caminho), { method: "PUT", body: JSON.stringify(corpo) });
    if (r.status === 409 || (r.status === 422 && !sha)) throw new ErroConflito(`${caminho} foi alterado em outro lugar.`);
    if (!r.ok) {
      let detalhe = "";
      try { detalhe = (await r.json()).message || ""; } catch {}
      throw new Error(`Erro do GitHub ao salvar (HTTP ${r.status}) ${detalhe}`.trim());
    }
    return (await r.json()).content.sha;
  }
  // ── Arquivos binários (anexos dos lembretes) ──

  async gravarBinario(caminho, bytes, mensagem) {
    const corpo = JSON.stringify({ message: mensagem, content: paraB64(bytes), branch: CONFIG.branch });
    for (let tentativa = 0; ; tentativa++) {
      const r = await this.api(urlConteudo(caminho), { method: "PUT", body: corpo });
      if (r.ok) return;
      // 409: o ramo andou ao mesmo tempo (ex.: o caderno acabou de salvar).
      if (r.status === 409 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 800)); continue; }
      let detalhe = "";
      try { detalhe = (await r.json()).message || ""; } catch {}
      throw new Error(`Erro do GitHub ao enviar o anexo (HTTP ${r.status}) ${detalhe}`.trim());
    }
  }

  async lerBinario(caminho) {
    const r = await this.api(`${urlConteudo(caminho)}?ref=${encodeURIComponent(CONFIG.branch)}`, {
      headers: { Accept: "application/vnd.github.raw" },
    });
    if (r.status === 404) throw new Error("O anexo não foi encontrado no GitHub (talvez ainda esteja sendo enviado).");
    if (!r.ok) throw new Error(`Erro do GitHub ao abrir o anexo (HTTP ${r.status}).`);
    return new Uint8Array(await r.arrayBuffer());
  }

  // Apaga um arquivo. Devolve sem erro se ele já não existir.
  async apagar(caminho, mensagem) {
    for (let tentativa = 0; ; tentativa++) {
      const r = await this.api(`${urlConteudo(caminho)}?ref=${encodeURIComponent(CONFIG.branch)}`);
      if (r.status === 404) return;
      if (!r.ok) throw new Error(`Erro do GitHub ao apagar ${caminho} (HTTP ${r.status}).`);
      const { sha } = await r.json();
      const d = await this.api(urlConteudo(caminho), {
        method: "DELETE",
        body: JSON.stringify({ message: mensagem, sha, branch: CONFIG.branch }),
      });
      if (d.ok || d.status === 404) return;
      if (d.status === 409 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 800)); continue; }
      throw new Error(`Erro do GitHub ao apagar ${caminho} (HTTP ${d.status}).`);
    }
  }
}
