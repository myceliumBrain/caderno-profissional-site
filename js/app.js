import {
  novaChaveMestra, criarFechadura, abrirFechadura, cifrar, decifrar,
  novoCodigoRecuperacao, normalizarCodigo,
} from "./cripto.js";
import { lerPublico, GitHub, ErroConflito, ErroAcesso } from "./armazenamento.js";
import { mesclarDados } from "./mesclar.js";
import { CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
//
// data/auth.json    → { fechaduras: [senha, recuperacao], token: {iv, dados} }
//                     A chave mestra fica trancada pela senha e pelo código de
//                     recuperação; o token do GitHub é cifrado com ela.
// data/caderno.json → { formato, versao, iv, dados }: pastas e textos cifrados
//                     com a mesma chave mestra.

const estado = {
  auth: null,           // conteúdo de data/auth.json
  shaAuth: null,        // versão de data/auth.json no GitHub
  shaCaderno: null,     // versão de data/caderno.json no GitHub (para detectar conflito)
  chave: null,          // chave mestra decifrada (só em memória)
  github: null,         // cliente da API com o token decifrado
  dados: null,          // conteúdo decifrado: { pastas, textos, removidos }
  pendente: false,
  salvando: false,
  salvarDeNovo: false,
  erro: "",
  pastaAtual: "todas",
  textoAtual: null,
  busca: "",
  entradaEditando: null,
};

const AUTOSALVAR_MS = 15000;
let timerAutosalvar = null;

const $ = (sel) => document.querySelector(sel);
const agora = () => new Date().toISOString();
const novoId = (prefixo) => `${prefixo}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dataLonga(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function quando(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const hoje = new Date();
  if (d.toDateString() === hoje.toDateString()) return `hoje, ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: d.getFullYear() === hoje.getFullYear() ? undefined : "numeric" });
}

function semAcento(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function mostrarTela(id) {
  document.querySelectorAll(".tela").forEach((t) => { t.hidden = t.id !== id; });
}

function mostrarErro(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg || "";
  el.hidden = !msg;
}

async function ocupado(botao, fn) {
  const texto = botao.textContent;
  botao.disabled = true;
  botao.textContent = "Aguarde…";
  try { return await fn(); } finally { botao.disabled = false; botao.textContent = texto; }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

if (window.DOMPurify) {
  DOMPurify.addHook("afterSanitizeAttributes", (no) => {
    if (no.tagName === "A") { no.setAttribute("target", "_blank"); no.setAttribute("rel", "noopener noreferrer"); }
  });
}

function renderizarMarkdown(texto) {
  if (!texto.trim()) return "";
  if (!window.marked || !window.DOMPurify) return `<p>${esc(texto).replace(/\n/g, "<br>")}</p>`;
  return DOMPurify.sanitize(marked.parse(texto, { gfm: true, breaks: true }));
}

const RE_TAREFA = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/gm;

function alternarTarefa(texto, indice) {
  let n = -1;
  return texto.replace(RE_TAREFA, (tudo, prefixo, marca) => {
    n += 1;
    if (n !== indice) return tudo;
    return `${prefixo}[${marca === " " ? "x" : " "}]`;
  });
}

function autoAltura(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// Monta um bloco de edição Markdown (textarea + pré-visualização).
// modo: "escrever" | "dividir" | "visualizar"
function montarMarkdown(el, { valor, modo, placeholder, aoMudar }) {
  el.classList.add("md");
  el.dataset.modo = modo;
  el.innerHTML = `<textarea spellcheck="true"></textarea><div class="preview markdown"></div>`;
  const ta = el.querySelector("textarea");
  const pv = el.querySelector(".preview");
  ta.value = valor || "";
  ta.placeholder = placeholder || "";

  const atualizar = () => {
    pv.innerHTML = renderizarMarkdown(ta.value) || `<p class="vazio">Nada escrito ainda.</p>`;
    pv.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.disabled = false; });
  };
  let t = null;
  ta.addEventListener("input", () => {
    aoMudar(ta.value);
    autoAltura(ta);
    clearTimeout(t);
    t = setTimeout(atualizar, 150);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const { selectionStart: i, selectionEnd: f } = ta;
      ta.setRangeText("  ", i, f, "end");
      ta.dispatchEvent(new Event("input"));
    }
  });
  pv.addEventListener("click", (e) => {
    const alvo = e.target;
    if (!(alvo instanceof HTMLInputElement) || alvo.type !== "checkbox") return;
    const indice = [...pv.querySelectorAll('input[type="checkbox"]')].indexOf(alvo);
    ta.value = alternarTarefa(ta.value, indice);
    aoMudar(ta.value);
    atualizar();
  });
  atualizar();
  requestAnimationFrame(() => autoAltura(ta));
  return { ta, pv };
}

// ---------------------------------------------------------------------------
// Caderno: abrir e salvar
// ---------------------------------------------------------------------------

function dadosIniciais() {
  const t = agora();
  return {
    pastas: [
      { id: novoId("pasta"), nome: "Protocolos do laboratório", criadoEm: t, atualizadoEm: t },
      { id: novoId("pasta"), nome: "Revisão de literatura", criadoEm: t, atualizadoEm: t },
    ],
    textos: [],
    removidos: {},
  };
}

// Grava data/auth.json (troca de senha, código ou token). Em conflito, a versão
// desta aba prevalece: ela acabou de ser confirmada por quem está usando.
async function gravarAuth(mensagem) {
  try {
    estado.shaAuth = await estado.github.gravar(CONFIG.authPath, estado.auth, estado.shaAuth, mensagem);
  } catch (e) {
    if (!(e instanceof ErroConflito)) throw e;
    const atual = await estado.github.ler(CONFIG.authPath);
    estado.shaAuth = await estado.github.gravar(CONFIG.authPath, estado.auth, atual?.sha, mensagem);
  }
}

async function gravarCaderno(mensagem) {
  const arquivo = { formato: "caderno", versao: 1, ...(await cifrar(estado.chave, estado.dados)) };
  estado.shaCaderno = await estado.github.gravar(CONFIG.cadernoPath, arquivo, estado.shaCaderno, mensagem);
}

function marcarAlterado() {
  estado.pendente = true;
  estado.erro = "";
  atualizarStatus();
  clearTimeout(timerAutosalvar);
  timerAutosalvar = setTimeout(() => salvar(), AUTOSALVAR_MS);
}

async function salvar() {
  clearTimeout(timerAutosalvar);
  if (!estado.pendente) return;
  if (estado.salvando) { estado.salvarDeNovo = true; return; }
  estado.salvando = true;
  estado.pendente = false;
  atualizarStatus();
  try {
    try {
      await gravarCaderno(`Caderno: atualização ${agora()}`);
    } catch (e) {
      if (!(e instanceof ErroConflito)) throw e;
      // Outro aparelho salvou antes: junta as duas versões e tenta de novo.
      const remoto = await estado.github.ler(CONFIG.cadernoPath);
      if (remoto) {
        estado.dados = mesclarDados(estado.dados, await decifrar(estado.chave, remoto.json));
        estado.shaCaderno = remoto.sha;
      }
      await gravarCaderno(`Caderno: atualização (mesclada) ${agora()}`);
      renderizarTudo();
    }
  } catch (e) {
    estado.pendente = true;
    estado.erro = (e.message || String(e)) + (e instanceof ErroAcesso ? " Cole um novo em ⚙ Configurações." : "");
  } finally {
    estado.salvando = false;
    atualizarStatus();
    if (estado.salvarDeNovo) { estado.salvarDeNovo = false; salvar(); }
  }
}

function atualizarStatus() {
  const el = $("#status");
  const botao = $("#salvar");
  el.className = "status";
  if (estado.erro) {
    el.textContent = `⚠ ${estado.erro}`;
    el.classList.add("erro");
  } else if (estado.salvando) {
    el.textContent = "Salvando…";
  } else if (estado.pendente) {
    el.textContent = "Alterações não salvas";
    el.classList.add("pendente");
  } else {
    el.textContent = "Tudo salvo";
    el.classList.add("ok");
  }
  botao.disabled = estado.salvando || !estado.pendente;
}

// Com a chave mestra em mãos: decifra o token e conecta ao GitHub.
async function conectar(chave) {
  estado.chave = chave;
  const { token } = await decifrar(chave, estado.auth.token);
  estado.github = new GitHub(token);
  const auth = await estado.github.ler(CONFIG.authPath);
  estado.shaAuth = auth?.sha ?? null;
}

// Busca o caderno mais recente no GitHub e abre o aplicativo.
async function abrirCaderno() {
  const arquivo = await estado.github.ler(CONFIG.cadernoPath);
  if (arquivo) {
    estado.dados = await decifrar(estado.chave, arquivo.json);
    estado.shaCaderno = arquivo.sha;
  } else {
    estado.dados = dadosIniciais();
    estado.shaCaderno = null;
    estado.pendente = true;
  }
  estado.dados.removidos ||= {};
  mostrarTela("app");
  renderizarTudo();
  atualizarStatus();
  if (estado.pendente) salvar();
}

// ---------------------------------------------------------------------------
// Telas de entrada
// ---------------------------------------------------------------------------

let acaoCodigo = null;

function mostrarCodigo(codigo, aoContinuar) {
  $("#codigo-valor").textContent = codigo;
  $("#codigo-ok").checked = false;
  $("#codigo-continuar").disabled = true;
  mostrarErro("erro-codigo", "");
  acaoCodigo = aoContinuar;
  mostrarTela("tela-codigo");
}

function irParaLogin(aviso = "") {
  mostrarErro("erro-login", aviso);
  mostrarTela("tela-login");
  $("#form-login").senha.focus();
}

function configurarTelasDeEntrada() {
  // Primeiro acesso: token + senha
  $("#form-config").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    mostrarErro("erro-config", "");
    await ocupado(form.querySelector("button[type=submit]"), async () => {
      try {
        const token = form.token.value.trim();
        const github = new GitHub(token);
        await github.validar();
        const existente = await github.ler(CONFIG.authPath);
        if (existente?.json?.fechaduras?.length) {
          // Já há acesso cadastrado (o site ainda não tinha atualizado): vai para a senha.
          estado.auth = existente.json;
          form.reset();
          return irParaLogin("Já existe um acesso cadastrado. Digite a senha.");
        }
        const chave = novaChaveMestra();
        const codigo = novoCodigoRecuperacao();
        const auth = {
          fechaduras: [
            await criarFechadura("senha", form.senha.value, chave),
            await criarFechadura("recuperacao", normalizarCodigo(codigo), chave),
          ],
          token: await cifrar(chave, { token }),
        };
        mostrarCodigo(codigo, async () => {
          estado.auth = auth;
          estado.chave = chave;
          estado.github = github;
          estado.shaAuth = await github.gravar(CONFIG.authPath, auth, existente?.sha, "Caderno: primeiro acesso");
          form.reset();
          await abrirCaderno();
        });
      } catch (err) {
        mostrarErro("erro-config", err.message);
      }
    });
  });

  // Código de recuperação
  $("#codigo-ok").addEventListener("change", (e) => { $("#codigo-continuar").disabled = !e.target.checked; });
  $("#codigo-copiar").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#codigo-valor").textContent); $("#codigo-copiar").textContent = "Copiado ✓"; } catch {}
  });
  $("#codigo-baixar").addEventListener("click", () => {
    const texto = `Código de recuperação do Caderno (gerado em ${new Date().toLocaleString("pt-BR")}):\n\n${$("#codigo-valor").textContent}\n\nUse em "Esqueci a senha" para definir uma nova senha.\n`;
    baixarArquivo("caderno-codigo-recuperacao.txt", texto, "text/plain");
  });
  $("#codigo-continuar").addEventListener("click", async (e) => {
    mostrarErro("erro-codigo", "");
    await ocupado(e.target, async () => {
      try { await acaoCodigo(); } catch (err) { mostrarErro("erro-codigo", err.message); }
    });
  });

  // Login: só a senha
  $("#form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    mostrarErro("erro-login", "");
    const senha = e.target.senha.value;
    await ocupado(e.target.querySelector("button[type=submit]"), async () => {
      let chave = null;
      for (const f of estado.auth.fechaduras.filter((c) => c.tipo === "senha")) {
        try { chave = await abrirFechadura(f, senha); break; } catch { /* não é esta */ }
      }
      if (!chave) return mostrarErro("erro-login", "Senha incorreta.");
      try {
        await conectar(chave);
        await abrirCaderno();
        e.target.reset();
      } catch (err) {
        mostrarErro("erro-login", err.message);
      }
    });
  });
  $("#ir-recuperar").addEventListener("click", () => mostrarTela("tela-recuperar"));
  $("#voltar-login").addEventListener("click", () => mostrarTela("tela-login"));

  // Recuperação: código → nova senha
  $("#form-recuperar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    mostrarErro("erro-recuperar", "");
    if (f.senha.value !== f.senha2.value) return mostrarErro("erro-recuperar", "As senhas não são iguais.");
    await ocupado(f.querySelector("button[type=submit]"), async () => {
      const fechadura = estado.auth.fechaduras.find((c) => c.tipo === "recuperacao");
      let chave;
      try {
        chave = await abrirFechadura(fechadura, normalizarCodigo(f.codigo.value));
      } catch {
        return mostrarErro("erro-recuperar", "Código de recuperação incorreto.");
      }
      try {
        const novaFechadura = await criarFechadura("senha", f.senha.value, chave);
        await conectar(chave);
        estado.auth.fechaduras = [...estado.auth.fechaduras.filter((c) => c.tipo !== "senha"), novaFechadura];
        await gravarAuth("Caderno: nova senha (recuperação)");
        f.reset();
        await abrirCaderno();
      } catch (err) {
        mostrarErro("erro-recuperar", err.message);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Pastas, lista e editor
// ---------------------------------------------------------------------------

const pastaPorId = (id) => estado.dados.pastas.find((p) => p.id === id);
const textoPorId = (id) => estado.dados.textos.find((t) => t.id === id);

function textoCompleto(t) {
  return [t.titulo, t.corpo, ...(t.entradas || []).map((e) => e.corpo)].join("\n");
}

function textosVisiveis() {
  let lista = estado.dados.textos;
  if (estado.busca) {
    const q = semAcento(estado.busca);
    lista = lista.filter((t) => semAcento(textoCompleto(t)).includes(q));
  } else if (estado.pastaAtual !== "todas") {
    lista = lista.filter((t) => t.pastaId === estado.pastaAtual);
  }
  return [...lista].sort((a, b) => (b.atualizadoEm || "").localeCompare(a.atualizadoEm || ""));
}

function definirVista(vista) {
  $("#app").dataset.vista = vista;
}

function renderizarTudo() {
  if (estado.pastaAtual !== "todas" && !pastaPorId(estado.pastaAtual)) estado.pastaAtual = "todas";
  if (estado.textoAtual && !textoPorId(estado.textoAtual)) estado.textoAtual = null;
  renderizarPastas();
  renderizarLista();
  renderizarEditor();
}

function renderizarPastas() {
  const contar = (id) => estado.dados.textos.filter((t) => t.pastaId === id).length;
  const item = (id, nome, n) => `
    <button class="pasta ${estado.pastaAtual === id && !estado.busca ? "ativa" : ""}" data-pasta="${esc(id)}">
      <span>${esc(nome)}</span><span class="contagem">${n}</span>
    </button>`;
  $("#lista-pastas").innerHTML =
    item("todas", "🕘 Todos os textos", estado.dados.textos.length) +
    estado.dados.pastas.map((p) => item(p.id, `📁 ${p.nome}`, contar(p.id))).join("");
}

function renderizarLista() {
  const pasta = pastaPorId(estado.pastaAtual);
  $("#titulo-pasta").textContent = estado.busca ? `Busca: “${estado.busca}”` : pasta ? pasta.nome : "Todos os textos";
  $("#menu-pasta").hidden = !pasta || !!estado.busca;
  const lista = textosVisiveis();
  if (!lista.length) {
    $("#lista-textos").innerHTML = `<li class="vazio">${estado.busca ? "Nada encontrado." : "Nenhum texto aqui ainda."}</li>`;
    return;
  }
  $("#lista-textos").innerHTML = lista.map((t) => {
    const trecho = (t.tipo === "diario" ? (t.entradas?.[0]?.corpo ?? t.corpo) : t.corpo) || "";
    const resumo = trecho.replace(/[#*_>`\-\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110);
    const nomePasta = estado.pastaAtual === "todas" || estado.busca ? pastaPorId(t.pastaId)?.nome : "";
    return `
      <li>
        <button class="item ${t.id === estado.textoAtual ? "ativo" : ""}" data-texto="${esc(t.id)}">
          <span class="item-titulo">${t.tipo === "diario" ? "📅 " : ""}${esc(t.titulo || "Sem título")}</span>
          <span class="item-meta">${esc(quando(t.atualizadoEm))}${nomePasta ? ` · ${esc(nomePasta)}` : ""}${t.tipo === "diario" ? ` · ${(t.entradas || []).length} entradas` : ""}</span>
          ${resumo ? `<span class="item-resumo">${esc(resumo)}</span>` : ""}
        </button>
      </li>`;
  }).join("");
}

function modoEditor() {
  try { return localStorage.getItem("caderno.modo") || "dividir"; } catch { return "dividir"; }
}

function definirModoEditor(modo) {
  try { localStorage.setItem("caderno.modo", modo); } catch {}
  document.querySelectorAll(".modos button").forEach((b) => b.classList.toggle("ativo", b.dataset.modo === modo));
  document.querySelectorAll(".md:not(.so-leitura)").forEach((el) => { el.dataset.modo = modo; });
  document.querySelectorAll(".md textarea").forEach(autoAltura);
}

function tocarTexto(t) {
  t.atualizadoEm = agora();
  marcarAlterado();
  renderizarLista();
}

function renderizarEditor() {
  const el = $("#painel-editor");
  const t = textoPorId(estado.textoAtual);
  if (!t) {
    el.innerHTML = `<div class="editor-vazio"><p>Escolha um texto ao lado ou crie um novo.</p></div>`;
    return;
  }
  const modo = modoEditor();
  const opcoesPasta = estado.dados.pastas.map((p) => `<option value="${esc(p.id)}" ${p.id === t.pastaId ? "selected" : ""}>${esc(p.nome)}</option>`).join("");
  el.innerHTML = `
    <div class="editor-topo">
      <button class="icone so-celular" id="voltar-lista" title="Voltar">←</button>
      <input class="titulo" id="titulo-texto" value="${esc(t.titulo)}" placeholder="Título">
    </div>
    <div class="editor-meta">
      <label>Pasta <select id="mover-texto">${opcoesPasta}</select></label>
      <span class="suave">Criado ${esc(quando(t.criadoEm))} · editado ${esc(quando(t.atualizadoEm))}</span>
      <span class="modos">
        <button data-modo="escrever" class="${modo === "escrever" ? "ativo" : ""}">Escrever</button><button data-modo="dividir" class="${modo === "dividir" ? "ativo" : ""}">Dividir</button><button data-modo="visualizar" class="${modo === "visualizar" ? "ativo" : ""}">Ler</button>
      </span>
      <button class="icone" id="excluir-texto" title="Excluir texto">🗑</button>
    </div>
    ${t.tipo === "diario"
      ? `<details class="descricao" ${t.corpo ? "open" : ""}><summary>Descrição do diário</summary><div id="corpo-texto"></div></details>`
      : `<div id="corpo-texto"></div>`}
    ${t.tipo === "diario" ? `
      <div class="diario-topo">
        <button class="botao primario" id="entrada-hoje">+ Entrada de hoje</button>
        <span class="suave">${esc(dataLonga(hojeISO()))}</span>
      </div>
      <div id="entradas"></div>` : ""}
  `;

  $("#titulo-texto").addEventListener("input", (e) => { t.titulo = e.target.value; tocarTexto(t); });
  $("#mover-texto").addEventListener("change", (e) => { t.pastaId = e.target.value; tocarTexto(t); renderizarPastas(); });
  $("#excluir-texto").addEventListener("click", () => excluirTexto(t));
  $("#voltar-lista").addEventListener("click", () => definirVista("lista"));
  el.querySelectorAll(".modos button").forEach((b) => b.addEventListener("click", () => definirModoEditor(b.dataset.modo)));

  const corpo = $("#corpo-texto");
  if (t.tipo === "diario") {
    corpo.classList.add("descricao-diario");
    corpo.closest("details").addEventListener("toggle", () => corpo.querySelectorAll("textarea").forEach(autoAltura));
  }
  montarMarkdown(corpo, {
    valor: t.corpo,
    modo,
    placeholder: t.tipo === "diario"
      ? "Descrição do diário (opcional): objetivo, perguntas da revisão, palavras-chave…"
      : "Escreva em Markdown: # Título, **negrito**, - lista, - [ ] passo a cumprir, | tabela |…",
    aoMudar: (v) => { t.corpo = v; tocarTexto(t); },
  });

  if (t.tipo === "diario") {
    $("#entrada-hoje").addEventListener("click", () => entradaDeHoje(t));
    renderizarEntradas(t);
  }
}

function renderizarEntradas(t) {
  const caixa = $("#entradas");
  const entradas = [...(t.entradas || [])].sort((a, b) => b.data.localeCompare(a.data) || (b.criadoEm || "").localeCompare(a.criadoEm || ""));
  if (!entradas.length) {
    caixa.innerHTML = `<p class="vazio">Nenhuma entrada ainda. Clique em “Entrada de hoje” para começar.</p>`;
    return;
  }
  caixa.innerHTML = "";
  for (const en of entradas) {
    const editando = estado.entradaEditando === en.id;
    const art = document.createElement("article");
    art.className = `entrada ${editando ? "editando" : ""}`;
    art.dataset.entrada = en.id;
    art.innerHTML = `
      <header>
        ${editando
          ? `<input type="date" value="${esc(en.data)}" class="data-entrada">`
          : `<h3>${esc(dataLonga(en.data))}</h3>`}
        <span class="acoes">
          <button class="botao pequeno alternar">${editando ? "Concluir" : "Editar"}</button>
          ${editando ? `<button class="icone excluir-entrada" title="Excluir entrada">🗑</button>` : ""}
        </span>
      </header>
      <div class="md-entrada"></div>`;
    caixa.appendChild(art);
    const md = art.querySelector(".md-entrada");
    if (!editando) md.classList.add("so-leitura");
    const { ta } = montarMarkdown(md, {
      valor: en.corpo,
      modo: editando ? modoEditor() : "visualizar",
      placeholder: "O que você leu/fez hoje? Referências, achados, próximos passos…",
      aoMudar: (v) => { en.corpo = v; en.atualizadoEm = agora(); tocarTexto(t); },
    });
    art.querySelector(".alternar").addEventListener("click", () => {
      estado.entradaEditando = editando ? null : en.id;
      renderizarEntradas(t);
    });
    if (editando) {
      art.querySelector(".data-entrada").addEventListener("change", (e) => {
        if (!e.target.value) return;
        en.data = e.target.value;
        tocarTexto(t);
      });
      art.querySelector(".excluir-entrada").addEventListener("click", () => {
        if (!confirm(`Excluir a entrada de ${dataLonga(en.data)}?`)) return;
        t.entradas = t.entradas.filter((x) => x.id !== en.id);
        estado.entradaEditando = null;
        tocarTexto(t);
        renderizarEntradas(t);
      });
      requestAnimationFrame(() => ta.focus());
    }
  }
}

function entradaDeHoje(t) {
  t.entradas ||= [];
  const hoje = hojeISO();
  let en = t.entradas.find((x) => x.data === hoje);
  if (!en) {
    en = { id: novoId("entrada"), data: hoje, corpo: "", criadoEm: agora(), atualizadoEm: agora() };
    t.entradas.push(en);
    tocarTexto(t);
  }
  estado.entradaEditando = en.id;
  renderizarEntradas(t);
  document.querySelector(`[data-entrada="${en.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function novoTexto(tipo) {
  let pastaId = estado.pastaAtual;
  if (pastaId === "todas" || !pastaPorId(pastaId)) {
    if (!estado.dados.pastas.length) criarPasta("Geral");
    pastaId = estado.dados.pastas[0].id;
  }
  const t = agora();
  const texto = {
    id: novoId("texto"), pastaId, tipo,
    titulo: tipo === "diario" ? `Diário — ${new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}` : "",
    corpo: "", entradas: tipo === "diario" ? [] : undefined,
    criadoEm: t, atualizadoEm: t,
  };
  estado.dados.textos.push(texto);
  estado.busca = "";
  $("#busca").value = "";
  estado.pastaAtual = pastaId;
  estado.textoAtual = texto.id;
  estado.entradaEditando = null;
  marcarAlterado();
  renderizarTudo();
  definirVista("editor");
  if (tipo === "diario") entradaDeHoje(texto);
  else $("#titulo-texto").focus();
}

function excluirTexto(t) {
  if (!confirm(`Excluir “${t.titulo || "Sem título"}”? Isso não pode ser desfeito pelo site.`)) return;
  estado.dados.textos = estado.dados.textos.filter((x) => x.id !== t.id);
  estado.dados.removidos[t.id] = agora();
  estado.textoAtual = null;
  marcarAlterado();
  renderizarTudo();
  definirVista("lista");
}

function criarPasta(nome) {
  const t = agora();
  const p = { id: novoId("pasta"), nome, criadoEm: t, atualizadoEm: t };
  estado.dados.pastas.push(p);
  marcarAlterado();
  return p;
}

function configurarApp() {
  $("#lista-pastas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pasta]");
    if (!b) return;
    estado.pastaAtual = b.dataset.pasta;
    estado.busca = "";
    $("#busca").value = "";
    renderizarPastas();
    renderizarLista();
    definirVista("lista");
  });

  $("#lista-textos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-texto]");
    if (!b) return;
    estado.textoAtual = b.dataset.texto;
    estado.entradaEditando = null;
    renderizarLista();
    renderizarEditor();
    definirVista("editor");
    $("#painel-editor").scrollTop = 0;
  });

  let tBusca = null;
  $("#busca").addEventListener("input", (e) => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => {
      estado.busca = e.target.value.trim();
      renderizarPastas();
      renderizarLista();
      if (estado.busca) definirVista("lista");
    }, 200);
  });

  $("#nova-pasta").addEventListener("click", () => {
    const nome = prompt("Nome da nova pasta:");
    if (!nome?.trim()) return;
    const p = criarPasta(nome.trim());
    estado.pastaAtual = p.id;
    renderizarTudo();
    definirVista("lista");
  });

  $("#renomear-pasta").addEventListener("click", () => {
    const p = pastaPorId(estado.pastaAtual);
    const nome = prompt("Novo nome da pasta:", p.nome);
    if (!nome?.trim()) return;
    p.nome = nome.trim();
    p.atualizadoEm = agora();
    marcarAlterado();
    renderizarTudo();
  });

  $("#excluir-pasta").addEventListener("click", () => {
    const p = pastaPorId(estado.pastaAtual);
    const dentro = estado.dados.textos.filter((t) => t.pastaId === p.id);
    const aviso = dentro.length ? ` e os ${dentro.length} texto(s) dentro dela` : "";
    if (!confirm(`Excluir a pasta “${p.nome}”${aviso}?`)) return;
    const t = agora();
    estado.dados.pastas = estado.dados.pastas.filter((x) => x.id !== p.id);
    estado.dados.textos = estado.dados.textos.filter((x) => x.pastaId !== p.id);
    estado.dados.removidos[p.id] = t;
    dentro.forEach((x) => { estado.dados.removidos[x.id] = t; });
    estado.pastaAtual = "todas";
    marcarAlterado();
    renderizarTudo();
  });

  $("#novo-texto").addEventListener("click", () => novoTexto("texto"));
  $("#novo-diario").addEventListener("click", () => novoTexto("diario"));
  $("#salvar").addEventListener("click", () => salvar());
  $("#abrir-pastas").addEventListener("click", () => {
    definirVista($("#app").dataset.vista === "pastas" ? "lista" : "pastas");
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && estado.chave) {
      e.preventDefault();
      salvar();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (estado.pendente || estado.salvando) { e.preventDefault(); e.returnValue = ""; }
  });

  configurarDialogoConfig();
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

function baixarArquivo(nome, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nome });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function msgConfig(texto, erro = false) {
  const el = $("#msg-config");
  el.textContent = texto;
  el.className = `msg ${erro ? "erro" : "ok"}`;
  el.hidden = !texto;
}

function configurarDialogoConfig() {
  const dlg = $("#dialogo-config");

  $("#abrir-config").addEventListener("click", () => {
    $("#info-repo").textContent = `Salvando em ${CONFIG.owner}/${CONFIG.repo} (branch ${CONFIG.branch}).`;
    msgConfig("");
    dlg.showModal();
  });

  $("#form-trocar-senha").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.senha.value !== f.senha2.value) return msgConfig("As senhas novas não são iguais.", true);
    await ocupado(f.querySelector("button"), async () => {
      let confere = false;
      for (const fe of estado.auth.fechaduras.filter((c) => c.tipo === "senha")) {
        try { await abrirFechadura(fe, f.atual.value); confere = true; break; } catch {}
      }
      if (!confere) return msgConfig("Senha atual incorreta.", true);
      try {
        const nova = await criarFechadura("senha", f.senha.value, estado.chave);
        estado.auth.fechaduras = [...estado.auth.fechaduras.filter((c) => c.tipo !== "senha"), nova];
        await gravarAuth("Caderno: troca de senha");
        f.reset();
        msgConfig("Senha trocada.");
      } catch (err) {
        msgConfig(`Não salvou: ${err.message}`, true);
      }
    });
  });

  $("#novo-codigo").addEventListener("click", async (e) => {
    if (!confirm("Gerar um novo código de recuperação? O código antigo deixará de funcionar.")) return;
    await ocupado(e.target, async () => {
      const codigo = novoCodigoRecuperacao();
      const fechadura = await criarFechadura("recuperacao", normalizarCodigo(codigo), estado.chave);
      dlg.close();
      mostrarCodigo(codigo, async () => {
        estado.auth.fechaduras = [...estado.auth.fechaduras.filter((c) => c.tipo !== "recuperacao"), fechadura];
        await gravarAuth("Caderno: novo código de recuperação");
        mostrarTela("app");
      });
    });
  });

  $("#form-token").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await ocupado(f.querySelector("button"), async () => {
      try {
        const token = f.token.value.trim();
        const github = new GitHub(token);
        await github.validar();
        estado.github = github;
        estado.auth.token = await cifrar(estado.chave, { token });
        await gravarAuth("Caderno: token atualizado");
        f.reset();
        estado.erro = "";
        atualizarStatus();
        msgConfig("Token atualizado.");
      } catch (err) {
        msgConfig(err.message, true);
      }
    });
  });

  $("#exportar").addEventListener("click", () => {
    baixarArquivo(`caderno-backup-${hojeISO()}.json`, JSON.stringify({ formato: "caderno-backup", exportadoEm: agora(), ...estado.dados }, null, 2), "application/json");
  });

  $("#importar").addEventListener("change", async (e) => {
    const arquivo = e.target.files[0];
    e.target.value = "";
    if (!arquivo) return;
    try {
      const b = JSON.parse(await arquivo.text());
      if (b.formato !== "caderno-backup" || !Array.isArray(b.pastas) || !Array.isArray(b.textos)) throw new Error("Este arquivo não é um backup do Caderno.");
      if (!confirm(`Juntar o backup (${b.pastas.length} pastas, ${b.textos.length} textos) ao caderno atual? Em textos repetidos, vale a versão editada por último.`)) return;
      estado.dados = mesclarDados(estado.dados, { pastas: b.pastas, textos: b.textos, removidos: {} });
      marcarAlterado();
      renderizarTudo();
      msgConfig("Backup importado. Lembre de salvar.");
    } catch (err) {
      msgConfig(err.message, true);
    }
  });

  $("#sair").addEventListener("click", async () => {
    if (estado.pendente) await salvar();
    if (estado.pendente && !confirm("Há alterações que não foram salvas. Sair mesmo assim?")) return;
    estado.pendente = false;
    location.reload();
  });
}

// ---------------------------------------------------------------------------
// Início: sem acesso cadastrado → primeiro acesso; com acesso → senha.
// ---------------------------------------------------------------------------

async function iniciar() {
  if (!window.crypto?.subtle) {
    document.body.innerHTML = `<p style="padding:2rem">Este site precisa de https:// ou localhost para funcionar (criptografia do navegador).</p>`;
    return;
  }
  $("#nome-repo").textContent = `${CONFIG.owner}/${CONFIG.repo}`;
  configurarTelasDeEntrada();
  configurarApp();
  try {
    estado.auth = await lerPublico(CONFIG.authPath);
  } catch (e) {
    mostrarTela("tela-config");
    mostrarErro("erro-config", e.message);
    return;
  }
  if (estado.auth?.fechaduras?.length) irParaLogin();
  else mostrarTela("tela-config");
}

iniciar();
