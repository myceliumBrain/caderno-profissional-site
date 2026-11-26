import {
  novaChaveMestra, criarFechadura, abrirFechadura, cifrar, decifrar,
  novoCodigoRecuperacao, normalizarCodigo, cifrarBytes, decifrarBytes,
} from "./cripto.js";
import { lerPublico, GitHub, ErroConflito, ErroAcesso } from "./armazenamento.js";
import { mesclarDados } from "./mesclar.js";
import { CONFIG } from "./config.js";
import {
  $, agora, novoId, esc, dataISO, horaISO, dataLonga, dataCurta, quando,
  semAcento, textoDeHtml, plural, baixarArquivo, diaExecucao, datasDoTexto,
} from "./util.js";
import { montarEditor, montarBarra, markdownParaHtml } from "./editor.js";
import { exportarPdf, exportarTxt, exportarDocx } from "./exportar.js";
import { guardarRascunho, lerRascunho, apagarRascunho, guardarPosicao, lerPosicao } from "./rascunho.js";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
//
// data/auth.json    → { fechaduras: [senha, recuperacao], token: {iv, dados} }
// data/caderno.json → { formato, versao, iv, dados }: pastas e textos cifrados.
//
// Nada é apagado: pastas, textos e entradas de diário enviados para a
// lixeira ganham o campo "naLixeira" (data) e podem ser restaurados.

const LIXEIRA = "__lixeira";
const AUTOSALVAR_MS = 15000;        // envia ao GitHub 15 s depois da última alteração
const RASCUNHO_MS = 600;            // cópia local cifrada quase imediata
const NOVA_TENTATIVA_MS = 30000;    // sem internet: tenta de novo a cada 30 s
const RETOMAR_MS = 2 * 60 * 60 * 1000; // reabre onde parou se saiu há menos de 2 h

function lerLS(chave, padrao = null) {
  try { return localStorage.getItem(chave) ?? padrao; } catch { return padrao; }
}
function gravarLS(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch {}
}

const estado = {
  auth: null,
  shaAuth: null,
  shaCaderno: null,
  chave: null,
  github: null,
  dados: null,          // { pastas, textos, lembretes, pastasLembretes, removidos }
  pendente: false,
  salvando: false,
  salvarDeNovo: false,
  erro: "",
  pagina: "inicio",     // inicio | pasta | lixeira | busca | texto
  pastaAtual: null,
  textoAtual: null,
  busca: "",
  modo: lerLS("caderno.modo") === "ler" ? "ler" : "escrever",
  recolhido: { pastas: lerLS("caderno.recolher.pastas") === "1", lista: true },
};

let timerAutosalvar = null;
let timerRascunho = null;
let timerNovaTentativa = null;

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

// Aviso no canto da tela, com "Desfazer" opcional.
let timerAviso = null;
function avisar(msg, desfazer = null) {
  let el = $("#aviso");
  if (!el) {
    el = document.createElement("div");
    el.id = "aviso";
    el.className = "aviso";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.innerHTML = `<span>${esc(msg)}</span>${desfazer ? '<button class="link" type="button">Desfazer</button>' : ""}`;
  el.hidden = false;
  if (desfazer) el.querySelector("button").addEventListener("click", () => { el.hidden = true; desfazer(); });
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => { el.hidden = true; }, 7000);
}

// ---------------------------------------------------------------------------
// Caderno: abrir, salvar e cópia local
// ---------------------------------------------------------------------------

function dadosIniciais() {
  const t = agora();
  return {
    pastas: [
      { id: novoId("pasta"), nome: "Protocolos do laboratório", criadoEm: t, atualizadoEm: t },
      { id: novoId("pasta"), nome: "Revisão de literatura", criadoEm: t, atualizadoEm: t },
    ],
    textos: [],
    lembretes: [],
    pastasLembretes: [],
    removidos: {},
  };
}

// Textos antigos (Markdown) → HTML do editor visual; entradas sem hora ganham
// a hora em que foram criadas. Devolve true se mudou algo.
function migrar(d) {
  let mudou = false;
  d.pastas ||= [];
  d.textos ||= [];
  d.removidos ||= {};
  d.lembretes ||= [];
  d.pastasLembretes ||= [];
  for (const t of d.textos) {
    if (t.formato !== "html") {
      t.corpo = markdownParaHtml(t.corpo || "");
      for (const e of t.entradas || []) e.corpo = markdownParaHtml(e.corpo || "");
      t.formato = "html";
      mudou = true;
    }
    // Texto pontual sem "dia de execução" (anterior a esse campo): o dia em que foi criado.
    if (t.tipo !== "diario" && !t.execucao && t.criadoEm) {
      t.execucao = diaExecucao(t);
      mudou = true;
    }
    for (const e of t.entradas || []) {
      if (!e.hora) {
        e.hora = horaISO(new Date(e.criadoEm || Date.now()));
        mudou = true;
      }
    }
  }
  return mudou;
}

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

function agendarRascunho() {
  clearTimeout(timerRascunho);
  timerRascunho = setTimeout(() => guardarRascunho(estado.chave, estado.dados), RASCUNHO_MS);
}

function marcarAlterado() {
  estado.pendente = true;
  if (!estado.salvando) estado.erro = "";
  atualizarStatus();
  agendarRascunho();
  clearTimeout(timerAutosalvar);
  timerAutosalvar = setTimeout(() => salvar(), AUTOSALVAR_MS);
}

function mensagemDeErro(e) {
  if (e instanceof TypeError) {
    return "Sem conexão. Suas alterações estão guardadas neste navegador e serão enviadas quando a internet voltar.";
  }
  return (e.message || String(e)) + (e instanceof ErroAcesso ? " Cole um novo token em ⚙ Configurações." : "");
}

async function salvar() {
  clearTimeout(timerAutosalvar);
  clearTimeout(timerNovaTentativa);
  if (!estado.pendente || !estado.github) return;
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
        const dadosRemotos = await decifrar(estado.chave, remoto.json);
        migrar(dadosRemotos);
        estado.dados = mesclarDados(estado.dados, dadosRemotos);
        estado.shaCaderno = remoto.sha;
      }
      await gravarCaderno(`Caderno: atualização (mesclada) ${agora()}`);
      renderizarPaineis();
      if (estado.pagina !== "texto") renderizarPrincipal();
    }
    estado.erro = "";
    processarFilaAnexos();
    if (!estado.pendente && !estado.salvarDeNovo) {
      clearTimeout(timerRascunho);
      apagarRascunho();
    }
  } catch (e) {
    estado.pendente = true;
    estado.erro = mensagemDeErro(e);
    guardarRascunho(estado.chave, estado.dados);
    timerNovaTentativa = setTimeout(() => salvar(), NOVA_TENTATIVA_MS);
  } finally {
    estado.salvando = false;
    atualizarStatus();
    if (estado.salvarDeNovo) { estado.salvarDeNovo = false; salvar(); }
  }
}

function atualizarStatus() {
  const el = $("#status");
  const botao = $("#salvar");
  if (!el) return;
  el.className = "status";
  el.title = "";
  if (estado.erro) {
    el.textContent = `⚠ ${estado.erro}`;
    el.title = estado.erro;
    el.classList.add("erro");
  } else if (estado.salvando) {
    el.textContent = "Salvando…";
  } else if (estado.pendente) {
    el.textContent = "Alterações não enviadas";
    el.title = "Já estão guardadas neste navegador; vão para o GitHub em instantes.";
    el.classList.add("pendente");
  } else {
    el.textContent = "Tudo salvo";
    el.classList.add("ok");
  }
  botao.disabled = estado.salvando || !estado.pendente;
  atualizarAvisosLembretes();
}

async function conectar(chave) {
  estado.chave = chave;
  const { token } = await decifrar(chave, estado.auth.token);
  estado.github = new GitHub(token);
  const auth = await estado.github.ler(CONFIG.authPath);
  estado.shaAuth = auth?.sha ?? null;
}

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
  if (migrar(estado.dados)) estado.pendente = true;

  // Alterações que ficaram só neste navegador (aba fechada, internet caiu…).
  let recuperou = false;
  const rascunho = await lerRascunho(estado.chave);
  if (rascunho?.dados) {
    migrar(rascunho.dados);
    const antes = JSON.stringify(estado.dados);
    estado.dados = mesclarDados(rascunho.dados, estado.dados);
    if (JSON.stringify(estado.dados) !== antes) {
      recuperou = true;
      estado.pendente = true;
    } else {
      apagarRascunho();
    }
  }

  mostrarTela("app");
  atualizarStatus();
  retomarPosicao(recuperou);
  if (recuperou) avisar("Recuperei alterações que ainda não tinham sido enviadas. Enviando agora…");
  if (estado.pendente) salvar();
  processarFilaAnexos(); // anexos excluídos que ainda não tinham sido apagados do GitHub
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const pastaPorId = (id) => estado.dados.pastas.find((p) => p.id === id);
const textoPorId = (id) => estado.dados.textos.find((t) => t.id === id);
const pastasAtivas = () => estado.dados.pastas.filter((p) => !p.naLixeira);
const porEdicao = (a, b) => (b.atualizadoEm || "").localeCompare(a.atualizadoEm || "");
const textoAtivo = (t) => !t.naLixeira && pastaPorId(t.pastaId) && !pastaPorId(t.pastaId).naLixeira;
const textosDaPasta = (id) => estado.dados.textos.filter((t) => t.pastaId === id && !t.naLixeira).sort(porEdicao);
const momento = (e) => `${e.data} ${e.hora || "00:00"}`;
const entradasAtivas = (t) => (t.entradas || []).filter((e) => !e.naLixeira).sort((a, b) => momento(b).localeCompare(momento(a)) || (b.criadoEm || "").localeCompare(a.criadoEm || ""));

function itensNaLixeira() {
  return {
    pastas: estado.dados.pastas.filter((p) => p.naLixeira).sort((a, b) => b.naLixeira.localeCompare(a.naLixeira)),
    textos: estado.dados.textos.filter((t) => t.naLixeira).sort((a, b) => b.naLixeira.localeCompare(a.naLixeira)),
    entradas: estado.dados.textos
      .filter((t) => !t.naLixeira)
      .flatMap((t) => (t.entradas || []).filter((e) => e.naLixeira).map((entrada) => ({ texto: t, entrada })))
      .sort((a, b) => b.entrada.naLixeira.localeCompare(a.entrada.naLixeira)),
  };
}

function totalNaLixeira() {
  const l = itensNaLixeira();
  return l.pastas.length + l.textos.length + l.entradas.length;
}

function resultadosDaBusca() {
  const q = semAcento(estado.busca);
  return estado.dados.textos.filter(textoAtivo).filter((t) => {
    const tudo = [t.titulo, textoDeHtml(t.corpo), ...entradasAtivas(t).map((e) => textoDeHtml(e.corpo))].join(" ");
    return semAcento(tudo).includes(q);
  }).sort(porEdicao);
}

// Resumo na lista: o "Sobre" no texto contínuo (nada, se estiver vazio); o
// começo do texto no pontual.
function resumo(t) {
  return textoDeHtml(t.corpo).slice(0, 140);
}

// Texto contínuo: datas da primeira e da última entrada.
function periodoDoDiario(t) {
  const en = entradasAtivas(t);
  if (!en.length) return "";
  const primeira = en[en.length - 1].data;
  const ultima = en[0].data;
  return primeira === ultima ? dataCurta(primeira) : `${dataCurta(primeira)} → ${dataCurta(ultima)}`;
}

function metaDoTexto(t, comPasta = false) {
  const partes = [`editado ${quando(t.atualizadoEm)}`];
  if (t.tipo !== "diario" && diaExecucao(t)) partes.unshift(`executado ${dataCurta(diaExecucao(t))}`);
  if (t.tipo === "diario") partes.push(plural(entradasAtivas(t).length, "entrada", "entradas"));
  if (comPasta) partes.push(`📓 ${pastaPorId(t.pastaId)?.nome || "?"}`);
  return partes.join(" · ");
}

const icone = (t) => (t.tipo === "diario" ? "📔" : "📄");

// Setinha que abre "Editar" e "Lixeira".
// itens: [{ rotulo, atributos, perigo }]
function menuOpcoes(itens, extra = "") {
  return `
    <div class="menu-caixa menu-acoes">
      <button class="seta" type="button" data-acao="abrir-menu" title="Opções" aria-label="Opções" aria-expanded="false" ${extra}>▾</button>
      <div class="menu-barra direita menu-flutuante" hidden>
        ${itens.map((i) => `<button class="menu-item${i.perigo ? " perigo" : ""}" type="button" ${i.atributos}>${i.rotulo}</button>`).join("")}
      </div>
    </div>`;
}

function menuAcoes(editar, lixeira, extra = "") {
  return menuOpcoes([
    { rotulo: "Editar", atributos: `data-acao="${editar}" ${extra}` },
    { rotulo: "Lixeira", atributos: `data-acao="${lixeira}" ${extra}`, perigo: true },
  ], extra);
}

// Na lixeira: "Restaurar" ou "Apagar definitivamente".
function menuLixeira(tipo, id, extra = "") {
  return menuOpcoes([
    { rotulo: "Restaurar", atributos: `data-restaurar-${tipo}="${esc(id)}" ${extra}` },
    { rotulo: "Apagar definitivamente", atributos: `data-apagar-${tipo}="${esc(id)}" ${extra}`, perigo: true },
  ]);
}

function fecharMenus(exceto = null) {
  document.querySelectorAll("#principal .menu-flutuante").forEach((m) => {
    if (m === exceto) return;
    m.hidden = true;
    m.parentElement.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", "false");
  });
}

const AJUDA_TIPOS = "Texto pontual: um documento único (ex.: um protocolo).\nTexto contínuo: um registro em entradas com data e hora (ex.: a revisão de literatura feita um pouco por dia).";

// ---------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------

function salvarPosicao() {
  guardarPosicao({
    pagina: estado.pagina,
    pastaAtual: estado.pastaAtual,
    textoAtual: estado.textoAtual,
    rolagem: $("#principal")?.scrollTop || 0,
  });
}

function retomarPosicao(forcar) {
  const p = lerPosicao();
  const recente = p && Date.now() - (p.quando || 0) < RETOMAR_MS;
  if (p && (forcar || recente)) {
    if (p.pagina === "texto" && p.textoAtual && textoPorId(p.textoAtual)) return abrirTexto(p.textoAtual, { rolagem: p.rolagem });
    if (p.pagina === "lixeira") return abrirLixeira();
    if (p.pagina === "pasta" && pastaPorId(p.pastaAtual) && !pastaPorId(p.pastaAtual).naLixeira) return abrirPasta(p.pastaAtual);
  }
  abrirInicio();
}

function limparBusca() {
  estado.busca = "";
  $("#busca").value = "";
}

function irPara(pagina, rolagem = 0) {
  estado.pagina = pagina;
  const app = $("#app");
  app.dataset.pagina = pagina;
  const t = textoPorId(estado.textoAtual);
  const semLista = pagina === "inicio" || pagina === "lixeira" || (pagina === "texto" && t && !textoAtivo(t));
  app.dataset.lista = semLista ? "nao" : "sim";
  fecharGaveta();
  renderizarPaineis();
  renderizarPrincipal();
  $("#principal").scrollTop = rolagem;
  salvarPosicao();
}

function abrirInicio() {
  estado.pastaAtual = null;
  estado.textoAtual = null;
  limparBusca();
  irPara("inicio");
}

function abrirPasta(id) {
  estado.pastaAtual = id;
  estado.textoAtual = null;
  limparBusca();
  irPara("pasta");
}

function abrirLixeira() {
  estado.pastaAtual = LIXEIRA;
  estado.textoAtual = null;
  limparBusca();
  irPara("lixeira");
}

function abrirTexto(id, { rolagem = 0 } = {}) {
  const t = textoPorId(id);
  if (!t) return abrirInicio();
  estado.textoAtual = id;
  if (textoAtivo(t)) estado.pastaAtual = t.pastaId;
  else estado.pastaAtual = LIXEIRA;
  irPara("texto", rolagem);
}

function buscar(q) {
  estado.busca = q.trim();
  $("#busca").value = q;
  if (estado.busca) {
    estado.textoAtual = null;
    irPara("busca");
  } else if (pastaPorId(estado.pastaAtual)) {
    abrirPasta(estado.pastaAtual);
  } else {
    abrirInicio();
  }
}

function voltar() {
  if (estado.pastaAtual === LIXEIRA) return abrirLixeira();
  if (pastaPorId(estado.pastaAtual)) return abrirPasta(estado.pastaAtual);
  abrirInicio();
}

function abrirGaveta() { $("#app").classList.add("gaveta-aberta"); }
function fecharGaveta() { $("#app")?.classList.remove("gaveta-aberta"); }

// ---------------------------------------------------------------------------
// Painéis laterais
// ---------------------------------------------------------------------------

function renderizarPaineis() {
  $("#painel-pastas").classList.toggle("recolhido", estado.recolhido.pastas);
  $("#painel-lista").classList.toggle("recolhido", estado.recolhido.lista);

  $("#lista-pastas").innerHTML = pastasAtivas().map((p) => `
    <button class="pasta ${estado.pastaAtual === p.id && estado.pagina !== "busca" ? "ativa" : ""}" data-pasta="${esc(p.id)}">
      <span>📓 ${esc(p.nome)}</span><span class="contagem">${textosDaPasta(p.id).length}</span>
    </button>`).join("");
  const n = totalNaLixeira();
  const lix = $("#abrir-lixeira");
  lix.innerHTML = `<span>🗑 Lixeira</span><span class="contagem">${n || ""}</span>`;
  lix.classList.toggle("ativa", estado.pastaAtual === LIXEIRA);
  $("#voltar-inicio").classList.toggle("ativa", estado.pagina === "inicio");

  const pasta = pastaPorId(estado.pastaAtual);
  const lista = estado.pagina === "busca" ? resultadosDaBusca() : pasta ? textosDaPasta(pasta.id) : [];
  $("#titulo-lista").textContent = estado.pagina === "busca" ? "Resultados" : pasta ? pasta.nome : "";
  $("#lista-textos").innerHTML = lista.length
    ? lista.map((t) => `
      <li><button class="item ${t.id === estado.textoAtual ? "ativo" : ""}" data-texto="${esc(t.id)}">
        <span class="item-titulo">${icone(t)} ${esc(t.titulo || "Sem título")}</span>
        <span class="item-meta">${esc(quando(t.atualizadoEm))}</span>
      </button></li>`).join("")
    : `<li class="vazio">Nenhum texto.</li>`;
}

function alternarPainel(qual) {
  estado.recolhido[qual] = !estado.recolhido[qual];
  if (qual === "pastas") gravarLS("caderno.recolher.pastas", estado.recolhido.pastas ? "1" : "0");
  renderizarPaineis();
}

// ---------------------------------------------------------------------------
// Área principal
// ---------------------------------------------------------------------------

function renderizarPrincipal() {
  const el = $("#principal");
  switch (estado.pagina) {
    case "pasta": return paginaPasta(el);
    case "lixeira": return paginaLixeira(el);
    case "busca": return paginaBusca(el);
    case "texto": return paginaTexto(el);
    default: return paginaInicio(el);
  }
}

// Cartão de um texto: clicar abre em Ler; os botões ao lado escolhem o modo.
// Datas de edição/execução e o resumo (no contínuo, o "Sobre") ficam
// escondidos em "mais informações +".
const infoAberta = new Set();

function itemGrande(t, comPasta = false) {
  const r = resumo(t);
  const diario = t.tipo === "diario";
  const periodo = diario ? periodoDoDiario(t) : "";
  const nEntradas = diario ? entradasAtivas(t).length : 0;
  const aberta = infoAberta.has(t.id);
  const meta = metaDoTexto(t, comPasta).split(" · ").filter((x) => !/^\d+ entradas?$/.test(x)).join(" · ");
  return `
    <li class="item-cartao${aberta ? " info-aberta" : ""}" data-texto="${esc(t.id)}" data-abrir="ler" title="Abrir para ler">
      <span class="item-icone">${icone(t)}</span>
      <div class="item-corpo">
        <button type="button" class="item-titulo" data-texto="${esc(t.id)}" data-abrir="ler">${esc(t.titulo || "Sem título")}</button>
        <button type="button" class="item-mais" data-info="${esc(t.id)}" aria-expanded="${aberta}">${aberta ? "menos informações −" : "mais informações +"}</button>
        ${aberta ? `
        <div class="item-info">
          <span class="item-meta">${esc(meta)}</span>
          ${r ? `<span class="item-resumo">${diario ? `<strong>Sobre:</strong> ` : ""}${esc(r)}</span>` : ""}
        </div>` : ""}
      </div>
      <div class="item-lado">
        ${diario ? `<span class="item-periodo" title="Primeira e última entrada">${periodo ? `${esc(periodo)} · ` : ""}${plural(nEntradas, "entrada", "entradas")}</span>` : ""}
        <span class="item-modos">
          <button type="button" class="botao pequeno" data-texto="${esc(t.id)}" data-abrir="ler">Ler</button>
          <button type="button" class="botao pequeno" data-texto="${esc(t.id)}" data-abrir="escrever">Escrever</button>
        </span>
      </div>
    </li>`;
}

function paginaInicio(el) {
  const cartoes = pastasAtivas().map((p) => {
    const textos = textosDaPasta(p.id);
    const recentes = textos.slice(0, 3).map((t) => `<li>${icone(t)} ${esc(t.titulo || "Sem título")}</li>`).join("");
    return `
      <button class="cartao-pasta" data-pasta="${esc(p.id)}">
        <span class="cartao-icone">📓</span>
        <span class="cartao-nome">${esc(p.nome)}</span>
        <span class="cartao-meta">${plural(textos.length, "texto", "textos")}${textos[0] ? ` · editado ${esc(quando(textos[0].atualizadoEm))}` : ""}</span>
        ${recentes ? `<ul class="cartao-recentes">${recentes}</ul>` : ""}
      </button>`;
  }).join("");
  const n = totalNaLixeira();
  el.innerHTML = `
    <div class="pagina pagina-inicio">
      <div class="inicio-pastas">
      <div class="pagina-topo">
        <h1>Meus cadernos</h1>
        <input type="search" id="busca-inicio" placeholder="Buscar em tudo…" value="${esc(estado.busca)}">
      </div>
      <div class="grade-pastas">
        ${cartoes}
        <button class="cartao-pasta nova" data-acao="nova-pasta">
          <span class="cartao-icone">＋</span><span class="cartao-nome">Novo caderno</span>
        </button>
        <button class="cartao-pasta lixeira" data-acao="abrir-lixeira">
          <span class="cartao-icone">🗑</span><span class="cartao-nome">Lixeira</span>
          <span class="cartao-meta">${n ? plural(n, "item", "itens") : "vazia"}</span>
        </button>
      </div>
      </div>
      <aside class="lembretes" id="lembretes" aria-label="Lembretes"></aside>
    </div>`;
  montarLembretes(el.querySelector("#lembretes"));
  el.querySelector("#busca-inicio").addEventListener("input", (e) => {
    clearTimeout(timerBusca);
    timerBusca = setTimeout(() => { buscar(e.target.value); requestAnimationFrame(() => $("#busca").focus()); }, 250);
  });
}

// ── Lembretes (página inicial) ──
// O "+" abre "Criar pasta" / "Criar lembrete". Pastas agrupam lembretes por
// tema (ex.: laboratório, casa) e se abrem dentro do próprio quadro.
// Cada lembrete tem título, descrição, cor, previsão e data limite de
// conclusão e anexos (fotos, PDFs…), cifrados em data/anexos/<id>.bin.
// Pendentes ficam no topo; concluídos vão para "Concluídos", onde podem
// voltar ou ser excluídos de vez, junto com os anexos.

const CORES_LEMBRETE = [
  { id: "vermelho", rotulo: "Prioritário" },
  { id: "azul", rotulo: "Intelectual" },
  { id: "verde", rotulo: "Rotina" },
  { id: "amarelo", rotulo: "Social" },
];
const AVISO_PREVISAO_DIAS = 4;  // "!"  a 4 dias da previsão de conclusão
const AVISO_LIMITE_DIAS = 7;    // "!!" a 7 dias da data limite
const ANEXO_MAX_MB = 25;
const caminhoAnexo = (id) => `data/anexos/${id}.bin`;

const rotuloCor = (c) => CORES_LEMBRETE.find((x) => x.id === c)?.rotulo || "";
// Estado do quadro (não vai para o GitHub).
const lem = {
  pasta: null, form: null, editando: null, editandoPasta: null,
  campos: {}, arquivos: [], remover: new Set(), focar: false, enviando: false, erro: "",
  mes: null, dia: null, destaque: null, abertos: new Set(),
};

const diaMes = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
function diasAte(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  const h = new Date();
  return Math.round((new Date(a, m - 1, d) - new Date(h.getFullYear(), h.getMonth(), h.getDate())) / 864e5);
}
function prazoTexto(dias) {
  if (dias < -1) return `atrasado há ${-dias} dias`;
  if (dias === -1) return "atrasado desde ontem";
  if (dias === 0) return "hoje";
  if (dias === 1) return "amanhã";
  return `em ${dias} dias`;
}
function tamanhoTexto(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function idsPastasLembretes() { return new Set(estado.dados.pastasLembretes.map((p) => p.id)); }
// Lembrete cuja pasta sumiu (ex.: excluída em outro aparelho) aparece na raiz.
function pastaDoLembrete(l, ids = idsPastasLembretes()) { return l.pasta && ids.has(l.pasta) ? l.pasta : null; }
const lembretesPendentes = () => estado.dados.lembretes.filter((l) => !l.concluidoEm);

// Nível de alerta de um lembrete pendente: 2 = "!!" (limite), 1 = "!" (previsão), 0 = nada.
function alertaDe(l) {
  if (l.concluidoEm) return null;
  if (l.limite && diasAte(l.limite) <= AVISO_LIMITE_DIAS) return { nivel: 2, data: l.limite, dias: diasAte(l.limite), tipo: "data limite" };
  if (l.previsao && diasAte(l.previsao) <= AVISO_PREVISAO_DIAS) return { nivel: 1, data: l.previsao, dias: diasAte(l.previsao), tipo: "previsão" };
  return null;
}

// ── Anexos: envio, abertura e fila de exclusão ──

const FILA_APAGAR = "caderno.anexosApagar";
let apagandoAnexos = false;

function apagarAnexos(ids) {
  if (!ids.length) return;
  let fila = [];
  try { fila = JSON.parse(lerLS(FILA_APAGAR, "[]")); } catch {}
  gravarLS(FILA_APAGAR, JSON.stringify([...new Set([...fila, ...ids])]));
  processarFilaAnexos();
}

// Apaga do GitHub os anexos pendentes; o que falhar (sem internet) fica na fila.
async function processarFilaAnexos() {
  if (apagandoAnexos || !estado.github) return;
  apagandoAnexos = true;
  try {
    let fila = [];
    try { fila = JSON.parse(lerLS(FILA_APAGAR, "[]")); } catch {}
    for (const id of fila) {
      try {
        await estado.github.apagar(caminhoAnexo(id), `Caderno: anexo apagado ${agora()}`);
        const resto = JSON.parse(lerLS(FILA_APAGAR, "[]")).filter((x) => x !== id);
        gravarLS(FILA_APAGAR, JSON.stringify(resto));
      } catch { break; }
    }
  } finally {
    apagandoAnexos = false;
  }
}

async function enviarAnexo(arquivo) {
  const id = novoId("anexo");
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  await estado.github.gravarBinario(caminhoAnexo(id), await cifrarBytes(estado.chave, bytes), `Caderno: anexo ${agora()}`);
  return { id, nome: arquivo.name, tipo: arquivo.type || "application/octet-stream", tamanho: arquivo.size, criadoEm: agora() };
}

async function abrirAnexo(a) {
  // A janela é aberta já no clique (senão o navegador bloqueia o pop-up).
  const visivel = /^(image\/|application\/pdf|text\/|video\/|audio\/)/.test(a.tipo);
  const janela = visivel ? window.open("", "_blank") : null;
  if (janela) janela.document.title = a.nome;
  avisar(`Abrindo “${a.nome}”…`);
  try {
    const bytes = await decifrarBytes(estado.chave, await estado.github.lerBinario(caminhoAnexo(a.id)));
    const blob = new Blob([bytes], { type: a.tipo });
    if (janela) {
      janela.location = URL.createObjectURL(blob);
      $("#aviso").hidden = true;
    } else {
      baixarArquivo(a.nome, blob);
    }
  } catch (e) {
    janela?.close();
    avisar(e instanceof TypeError ? "Sem conexão: não deu para abrir o anexo." : e.message);
  }
}

// ── Desenho ──

// ── Fontes (links) ──
// Só endereços http(s); sem "https://", ele é acrescentado.
function normalizarUrl(bruto) {
  let t = (bruto || "").trim();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}

function nomeDaFonte(f) {
  if (f.titulo) return f.titulo;
  try {
    const u = new URL(f.url);
    const caminho = u.pathname === "/" ? "" : u.pathname;
    return (u.hostname.replace(/^www\./, "") + caminho).slice(0, 60);
  } catch { return f.url; }
}

// Passa o link digitado para a lista de fontes do formulário. false = link inválido.
function adicionarFonte() {
  const c = lem.campos;
  const url = normalizarUrl(c.fonteUrl);
  if (!url) {
    if ((c.fonteUrl || "").trim()) lem.erro = "Esse link não parece válido (use um endereço de site, ex.: www.exemplo.com).";
    return false;
  }
  (c.fontes ||= []).push({ url, titulo: (c.fonteTitulo || "").trim() || null });
  c.fonteUrl = "";
  c.fonteTitulo = "";
  lem.erro = "";
  return true;
}

function escolherCor(atual) {
  const opcoes = [{ id: "", rotulo: "Sem cor" }, ...CORES_LEMBRETE];
  return `
    <div class="escolher-cor" role="radiogroup" aria-label="Cor">
      ${opcoes.map((c) => `
        <label class="opcao-cor" title="${esc(c.rotulo)}">
          <input type="radio" name="cor" value="${c.id}" ${c.id === (atual || "") ? "checked" : ""}>
          <span class="bolinha cor-${c.id || "nenhuma"}"></span><span>${esc(c.rotulo)}</span>
        </label>`).join("")}
    </div>`;
}

function formLembrete() {
  const c = lem.campos;
  const l = lem.editando && estado.dados.lembretes.find((x) => x.id === lem.editando);
  const anexos = (l?.anexos || []).filter((a) => !lem.remover.has(a.id));
  const pastas = [...estado.dados.pastasLembretes].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return `
    <form class="form-lembrete" data-form="lembrete" autocomplete="off">
      <input name="texto" maxlength="300" placeholder="Título do lembrete" aria-label="Título" value="${esc(c.texto || "")}">
      <textarea name="descricao" rows="2" maxlength="4000" placeholder="Descrição (opcional)" aria-label="Descrição">${esc(c.descricao || "")}</textarea>
      ${escolherCor(c.cor)}
      <div class="campos-datas">
        <label>Previsão de conclusão<input type="date" name="previsao" value="${esc(c.previsao || "")}"></label>
        <label>Data limite para conclusão<input type="date" name="limite" value="${esc(c.limite || "")}"></label>
      </div>
      ${pastas.length ? `
      <label class="campo-pasta">Pasta
        <select name="pasta">
          <option value="">Sem pasta</option>
          ${pastas.map((p) => `<option value="${esc(p.id)}" ${p.id === c.pasta ? "selected" : ""}>${esc(p.nome)}</option>`).join("")}
        </select>
      </label>` : ""}
      <div class="campo-fontes">
        <span class="rotulo-campo">Fontes</span>
        ${(c.fontes || []).map((f, i) => `<span class="fonte-item">🔗 <span class="fonte-nome" title="${esc(f.url)}">${esc(nomeDaFonte(f))}</span><button type="button" data-tirar-fonte="${i}" title="Remover fonte" aria-label="Remover fonte">✕</button></span>`).join("")}
        <div class="nova-fonte">
          <input name="fonteUrl" type="url" inputmode="url" placeholder="Link de uma fonte (site, artigo…)" aria-label="Link da fonte" value="${esc(c.fonteUrl || "")}">
          <input name="fonteTitulo" maxlength="120" placeholder="Nome (opcional)" aria-label="Nome da fonte" value="${esc(c.fonteTitulo || "")}">
          <button class="botao pequeno" type="button" data-lem="add-fonte">🔗 Adicionar</button>
        </div>
      </div>
      <div class="campo-anexos">
        ${anexos.map((a) => `<span class="anexo">📎 ${esc(a.nome)} <small>${tamanhoTexto(a.tamanho)}</small><button type="button" data-tirar-anexo="${esc(a.id)}" title="Remover anexo" aria-label="Remover ${esc(a.nome)}">✕</button></span>`).join("")}
        ${lem.arquivos.map((f, i) => `<span class="anexo novo">📎 ${esc(f.name)} <small>${tamanhoTexto(f.size)}</small><button type="button" data-tirar-arquivo="${i}" title="Remover anexo" aria-label="Remover ${esc(f.name)}">✕</button></span>`).join("")}
        <label class="botao pequeno anexar">📎 Anexar arquivos<input type="file" multiple hidden data-arquivos></label>
      </div>
      ${lem.erro ? `<p class="erro-lembrete">${esc(lem.erro)}</p>` : ""}
      <div class="form-botoes">
        <button class="botao pequeno" type="button" data-lem="cancelar" ${lem.enviando ? "disabled" : ""}>Cancelar</button>
        <button class="botao primario pequeno" type="submit" ${lem.enviando ? "disabled" : ""}>${lem.enviando ? "Enviando anexos…" : l ? "Salvar" : "Adicionar"}</button>
      </div>
    </form>`;
}

function formPasta() {
  const c = lem.campos;
  return `
    <form class="form-lembrete" data-form="pasta" autocomplete="off">
      <input name="nome" maxlength="80" placeholder="Nome da pasta (ex.: Laboratório)" aria-label="Nome da pasta" value="${esc(c.nome || "")}">
      ${escolherCor(c.cor)}
      <div class="form-botoes">
        <button class="botao pequeno" type="button" data-lem="cancelar">Cancelar</button>
        <button class="botao primario pequeno" type="submit">${lem.editandoPasta ? "Salvar" : "Criar pasta"}</button>
      </div>
    </form>`;
}

function datasDoLembrete(l) {
  const partes = [];
  const al = alertaDe(l);
  if (l.previsao) {
    const quente = al?.nivel === 1 ? " perto" : "";
    partes.push(`<span class="data-lembrete${quente}" title="Previsão de conclusão">previsão ${diaMes(l.previsao)}</span>`);
  }
  if (l.limite) {
    const quente = al?.nivel === 2 ? " urgente" : "";
    partes.push(`<span class="data-lembrete${quente}" title="Data limite para conclusão">limite ${diaMes(l.limite)}</span>`);
  }
  return partes.join(" ");
}

// A data que vale agora, mostrada ao lado do título: a do alerta, se houver;
// senão a previsão (enquanto não passou) e depois a data limite.
function dataAtiva(l) {
  const al = alertaDe(l);
  if (al) return { tipo: al.nivel === 2 ? "limite" : "previsão", data: al.data, nivel: al.nivel };
  if (l.previsao && (diasAte(l.previsao) >= 0 || !l.limite)) return { tipo: "previsão", data: l.previsao, nivel: 0 };
  if (l.limite) return { tipo: "limite", data: l.limite, nivel: 0 };
  return null;
}

// Fechado, o lembrete mostra só título, data ativa e ✎; a setinha abaixo do
// título abre descrição, anexos, categoria e as duas datas.
function itemLembrete(l, feito) {
  if (lem.editando === l.id) return `<li class="editando">${formLembrete()}</li>`;
  const cor = l.cor ? ` cor-${l.cor}` : "";
  const al = feito ? null : alertaDe(l);
  const ativa = feito ? null : dataAtiva(l);
  const aberto = lem.abertos.has(l.id);
  const nAnexos = l.anexos?.length || 0;
  const nFontes = l.fontes?.length || 0;
  const rotulo = l.descricao ? "descrição" : "detalhes";
  return `
    <li class="${feito ? "feito" : ""}${cor}${lem.destaque === l.id ? " destaque" : ""}" data-lembrete="${esc(l.id)}">
      <div class="lembrete-linha">
        <input type="checkbox" ${feito ? `checked data-reabrir="${esc(l.id)}" title="Voltar para pendentes"` : `data-concluir="${esc(l.id)}" title="Marcar como concluído"`} aria-label="${esc(l.texto)}">
        <span class="lembrete-texto">${al ? `<span class="marca-alerta nivel-${al.nivel}" title="${esc(`${al.tipo}: ${prazoTexto(al.dias)}`)}">${al.nivel === 2 ? "!!" : "!"}</span> ` : ""}${esc(l.texto)}</span>
        <div class="lembrete-acoes">
          ${ativa ? `<span class="data-ativa nivel-${ativa.nivel}" title="${esc(`${ativa.tipo === "limite" ? "Data limite para conclusão" : "Previsão de conclusão"}: ${dataCurta(ativa.data)} (${prazoTexto(diasAte(ativa.data))})`)}">${ativa.tipo === "limite" ? "limite" : "prev."} ${diaMes(ativa.data)}</span>` : ""}
          <button class="editar-lembrete" type="button" data-editar="${esc(l.id)}" title="Editar" aria-label="Editar">✎</button>
          ${feito ? `<button class="excluir-lembrete" type="button" data-excluir="${esc(l.id)}" title="Excluir de vez (com os anexos)">Excluir</button>` : ""}
        </div>
      </div>
      <div class="lembrete-baixo">
        <button type="button" class="abrir-detalhes" data-detalhes="${esc(l.id)}" aria-expanded="${aberto}">
          <span class="seta-detalhes">${aberto ? "▾" : "▸"}</span> ${rotulo}${nFontes ? ` · 🔗 ${nFontes}` : ""}${nAnexos ? ` · 📎 ${nAnexos}` : ""}
        </button>
        ${aberto ? `
        <div class="lembrete-detalhes">
          ${l.descricao ? `<span class="lembrete-desc">${esc(l.descricao)}</span>` : ""}
          ${nFontes ? `<span class="lembrete-fontes">${l.fontes.map((f) => `<a class="fonte" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" title="${esc(f.url)}">🔗 ${esc(nomeDaFonte(f))}</a>`).join("")}</span>` : ""}
          ${nAnexos ? `<span class="lembrete-anexos">${l.anexos.map((a) => `<button type="button" class="anexo" data-anexo="${esc(a.id)}" data-de="${esc(l.id)}" title="Abrir ${esc(a.nome)}">📎 ${esc(a.nome)}</button>`).join("")}</span>` : ""}
          <span class="lembrete-meta">${l.cor ? `<span class="etiqueta-cor cor-${l.cor}">${esc(rotuloCor(l.cor))}</span> ` : ""}${datasDoLembrete(l)} ${feito ? `concluído ${esc(quando(l.concluidoEm))}` : `criado ${esc(quando(l.criadoEm))}`}</span>
        </div>` : ""}
      </div>
    </li>`;
}

// Calendário do mês, como numa agenda: cada lembrete aparece no dia da
// previsão (fundo claro) e no dia da data limite (cor cheia).
function calendarioHtml() {
  const hoje = dataISO();
  const mes = lem.mes || hoje.slice(0, 7);
  const [a, m] = mes.split("-").map(Number);
  const primeiro = new Date(a, m - 1, 1);
  const inicio = new Date(a, m - 1, 1 - primeiro.getDay());
  const semanas = Math.ceil((primeiro.getDay() + new Date(a, m, 0).getDate()) / 7);
  const eventos = {};
  for (const l of estado.dados.lembretes) {
    if (l.previsao) (eventos[l.previsao] ||= []).push({ l, tipo: "prev" });
    if (l.limite) (eventos[l.limite] ||= []).push({ l, tipo: "lim" });
  }
  for (const lista of Object.values(eventos)) lista.sort((x, y) => (x.l.concluidoEm ? 1 : 0) - (y.l.concluidoEm ? 1 : 0) || (x.tipo === "lim" ? -1 : 1));
  const ev = (e) => `<span class="ev ${e.tipo} cor-${e.l.cor || "nenhuma"}${e.l.concluidoEm ? " feito" : ""}" title="${esc(`${e.tipo === "lim" ? "Data limite" : "Previsão"}: ${e.l.texto}`)}">${esc(e.l.texto)}</span>`;
  let dias = "";
  for (let i = 0; i < semanas * 7; i++) {
    const d = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i);
    const iso = dataISO(d);
    const lista = eventos[iso] || [];
    const classes = ["dia", d.getMonth() !== m - 1 && "fora", iso === hoje && "hoje", iso === lem.dia && "sel"].filter(Boolean).join(" ");
    dias += `<button type="button" class="${classes}" data-dia="${iso}" aria-label="${esc(dataLonga(iso))}${lista.length ? `, ${plural(lista.length, "lembrete", "lembretes")}` : ""}">
      <span class="num">${d.getDate()}</span>
      ${lista.slice(0, 2).map(ev).join("")}
      ${lista.length > 2 ? `<span class="ev-mais">+${lista.length - 2}</span>` : ""}
    </button>`;
  }
  const titulo = primeiro.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const doDia = lem.dia ? eventos[lem.dia] || [] : [];
  return `
    <section class="calendario" aria-label="Calendário dos lembretes">
      <div class="cal-topo">
        <button type="button" class="cal-nav" data-mes="-1" title="Mês anterior" aria-label="Mês anterior">‹</button>
        <strong class="cal-titulo">${esc(titulo.charAt(0).toUpperCase() + titulo.slice(1))}</strong>
        <button type="button" class="cal-nav" data-mes="1" title="Próximo mês" aria-label="Próximo mês">›</button>
        <button type="button" class="cal-hoje" data-mes="0">Hoje</button>
      </div>
      <div class="cal-grade">
        ${["D", "S", "T", "Q", "Q", "S", "S"].map((x) => `<span class="cal-sem">${x}</span>`).join("")}
        ${dias}
      </div>
      <div class="cal-legenda"><span><span class="ev prev cor-nenhuma">&nbsp;&nbsp;&nbsp;</span> previsão</span><span><span class="ev lim cor-nenhuma">&nbsp;&nbsp;&nbsp;</span> data limite</span></div>
      ${lem.dia ? `
      <div class="cal-dia">
        <strong>${esc(dataLonga(lem.dia))}</strong>
        ${doDia.length ? `<ul>${doDia.map((e) => `
          <li><button type="button" class="cal-item cor-${e.l.cor || "nenhuma"}${e.l.concluidoEm ? " feito" : ""}" data-ir="${esc(e.l.id)}">
            <span class="bolinha"></span>${e.tipo === "lim" ? "Data limite" : "Previsão"}: ${esc(e.l.texto)}
          </button></li>`).join("")}</ul>` : `<p class="lembretes-vazio">Nada marcado neste dia.</p>`}
      </div>` : ""}
    </section>`;
}

function abrirFormLembrete(l = null) {
  const pasta = lem.pasta && estado.dados.pastasLembretes.find((p) => p.id === lem.pasta);
  Object.assign(lem, {
    form: l ? null : "lembrete", editando: l?.id || null, editandoPasta: null,
    arquivos: [], remover: new Set(), erro: "", focar: true,
    campos: l
      ? { texto: l.texto, descricao: l.descricao || "", cor: l.cor || "", previsao: l.previsao || "", limite: l.limite || "", pasta: pastaDoLembrete(l) || "", fontes: [...(l.fontes || [])] }
      : { cor: pasta?.cor || "", pasta: lem.pasta || "", fontes: [] },
  });
}

function fecharForms() {
  Object.assign(lem, { form: null, editando: null, editandoPasta: null, campos: {}, arquivos: [], remover: new Set(), erro: "", enviando: false });
}

// Vai até um lembrete (pelos alertas do rodapé ou pelo calendário).
function irParaLembrete(id) {
  const l = estado.dados.lembretes.find((x) => x.id === id);
  if (!l) return;
  fecharForms();
  lem.pasta = pastaDoLembrete(l);
  lem.destaque = id;
  if (l.concluidoEm) gravarLS("caderno.concluidos", "1");
  if (estado.pagina !== "inicio") abrirInicio();
  else montarLembretes($("#lembretes"));
  const li = $(`#lembretes [data-lembrete="${CSS.escape(id)}"]`);
  li?.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => { lem.destaque = null; li?.classList.remove("destaque"); }, 2500);
}

function montarLembretes(caixa) {
  if (!caixa) return;
  const d = estado.dados;
  const ids = idsPastasLembretes();
  const pasta = lem.pasta && d.pastasLembretes.find((p) => p.id === lem.pasta);
  if (!pasta) lem.pasta = null;
  const daqui = d.lembretes.filter((l) => pastaDoLembrete(l, ids) === lem.pasta);
  const pendentes = daqui.filter((l) => !l.concluidoEm)
    .sort((a, b) => (alertaDe(b)?.nivel || 0) - (alertaDe(a)?.nivel || 0) || (a.criadoEm || "").localeCompare(b.criadoEm || ""));
  const concluidos = daqui.filter((l) => l.concluidoEm)
    .sort((a, b) => b.concluidoEm.localeCompare(a.concluidoEm));
  const pendentesDa = (id) => d.lembretes.filter((l) => l.pasta === id && !l.concluidoEm).length;
  const pastas = pasta ? [] : [...d.pastasLembretes].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const abertos = lerLS("caderno.concluidos") === "1" || concluidos.some((l) => l.id === lem.editando);

  const form = lem.form === "lembrete" ? formLembrete() : (lem.form === "pasta" || lem.editandoPasta) ? formPasta() : "";
  const rolagem = caixa.scrollTop;

  caixa.innerHTML = `
    <div class="lembretes-topo">
      ${pasta ? `<button class="voltar-lembretes" type="button" data-lem="voltar" title="Voltar para Lembretes" aria-label="Voltar para Lembretes">←</button>` : ""}
      <h2>${pasta ? `<span class="bolinha cor-${pasta.cor || "nenhuma"}"></span>${esc(pasta.nome)}` : "Lembretes"}</h2>
      ${pendentes.length ? `<span class="selo-contagem">${pendentes.length}</span>` : ""}
      <span class="espaco"></span>
      ${pasta ? `
        <div class="menu-caixa menu-acoes">
          <button class="seta" type="button" data-acao="abrir-menu" title="Opções da pasta" aria-label="Opções da pasta" aria-expanded="false">▾</button>
          <div class="menu-barra direita menu-flutuante" hidden>
            <button class="menu-item" type="button" data-lem="editar-pasta">Editar pasta</button>
            <button class="menu-item perigo" type="button" data-lem="excluir-pasta">Excluir pasta</button>
          </div>
        </div>` : ""}
      <div class="menu-caixa">
        <button class="botao primario pequeno mais-lembrete" type="button" ${pasta ? `data-lem="novo-lembrete"` : `data-acao="abrir-menu"`} title="${pasta ? "Criar lembrete" : "Criar…"}" aria-label="${pasta ? "Criar lembrete" : "Criar"}" aria-expanded="false">+</button>
        ${pasta ? "" : `
        <div class="menu-barra direita menu-flutuante" hidden>
          <button class="menu-item" type="button" data-lem="nova-pasta">📁 Criar pasta</button>
          <button class="menu-item" type="button" data-lem="novo-lembrete">☑ Criar lembrete</button>
        </div>`}
      </div>
    </div>
    ${form}
    ${pastas.length ? `<ul class="pastas-lembretes">${pastas.map((p) => {
      const n = pendentesDa(p.id);
      return `<li><button type="button" class="pasta-lembrete cor-${p.cor || "nenhuma"}" data-lem-pasta="${esc(p.id)}">
        <span class="pasta-lembrete-icone">📁</span>
        <span class="pasta-lembrete-nome">${esc(p.nome)}</span>
        ${p.cor ? `<span class="etiqueta-cor cor-${p.cor}">${esc(rotuloCor(p.cor))}</span>` : ""}
        <span class="pasta-lembrete-n">${n || ""}</span>
      </button></li>`;
    }).join("")}</ul>` : ""}
    ${pendentes.length ? `<ul class="lista-lembretes">${pendentes.map((l) => itemLembrete(l, false)).join("")}</ul>`
      : (pastas.length ? "" : `<p class="lembretes-vazio">Nada pendente.</p>`)}
    ${concluidos.length ? `
    <details class="concluidos" ${abertos ? "open" : ""}>
      <summary>Concluídos (${concluidos.length})</summary>
      <ul class="lista-lembretes">${concluidos.map((l) => itemLembrete(l, true)).join("")}</ul>
    </details>` : ""}
    ${calendarioHtml()}`;

  caixa.scrollTop = rolagem;
  const redesenhar = () => montarLembretes(caixa);
  if (lem.focar) {
    lem.focar = false;
    const campo = caixa.querySelector(".form-lembrete input[name=texto], .form-lembrete input[name=nome]");
    campo?.focus();
    campo?.scrollIntoView({ block: "nearest" });
  }

  caixa.querySelector(".form-lembrete")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (lem.enviando) return;
    const c = lem.campos;
    const t = agora();
    if (e.target.dataset.form === "pasta") {
      const nome = (c.nome || "").trim();
      if (!nome) return;
      const editando = lem.editandoPasta && d.pastasLembretes.find((p) => p.id === lem.editandoPasta);
      if (editando) Object.assign(editando, { nome, cor: c.cor || null, atualizadoEm: t });
      else d.pastasLembretes.push({ id: novoId("pastalem"), nome, cor: c.cor || null, criadoEm: t, atualizadoEm: t });
      fecharForms();
      marcarAlterado();
      return redesenhar();
    }

    const texto = (c.texto || "").trim();
    if (!texto) { lem.erro = "Dê um título ao lembrete."; lem.focar = true; return redesenhar(); }
    if ((c.fonteUrl || "").trim() && !adicionarFonte()) return redesenhar();
    if (c.previsao && c.limite && c.limite < c.previsao) { lem.erro = "A data limite não pode ser antes da previsão de conclusão."; return redesenhar(); }
    const grande = lem.arquivos.find((f) => f.size > ANEXO_MAX_MB * 1024 * 1024);
    if (grande) { lem.erro = `“${grande.name}” passa de ${ANEXO_MAX_MB} MB.`; return redesenhar(); }

    // Envia os anexos novos antes de gravar o lembrete.
    let novos = [];
    if (lem.arquivos.length) {
      if (!estado.github) { lem.erro = "Sem conexão com o GitHub para enviar os anexos."; return redesenhar(); }
      lem.enviando = true;
      lem.erro = "";
      redesenhar();
      try {
        for (const f of lem.arquivos) novos.push(await enviarAnexo(f));
      } catch (err) {
        lem.enviando = false;
        lem.erro = err instanceof TypeError ? "Sem conexão: os anexos não foram enviados. Tente de novo." : err.message;
        apagarAnexos(novos.map((a) => a.id)); // não deixa anexos pela metade
        return montarLembretes($("#lembretes"));
      }
    }

    const campos = {
      texto,
      descricao: (c.descricao || "").trim(),
      cor: c.cor || null,
      previsao: c.previsao || null,
      limite: c.limite || null,
      pasta: c.pasta || null,
      fontes: c.fontes || [],
    };
    const existente = lem.editando && d.lembretes.find((x) => x.id === lem.editando);
    if (existente) {
      const tirados = (existente.anexos || []).filter((a) => lem.remover.has(a.id));
      Object.assign(existente, campos, {
        anexos: [...(existente.anexos || []).filter((a) => !lem.remover.has(a.id)), ...novos],
        atualizadoEm: agora(),
      });
      apagarAnexos(tirados.map((a) => a.id));
    } else {
      d.lembretes.push({ id: novoId("lembrete"), ...campos, anexos: novos, criadoEm: t, atualizadoEm: agora(), concluidoEm: null });
    }
    fecharForms();
    marcarAlterado();
    montarLembretes($("#lembretes"));
  });
  caixa.querySelector("details.concluidos")?.addEventListener("toggle", (e) => gravarLS("caderno.concluidos", e.target.open ? "1" : "0"));

  caixa.querySelectorAll(".nova-fonte input").forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    adicionarFonte();
    lem.focarFonte = true;
    redesenhar();
  }));
  if (lem.focarFonte) {
    lem.focarFonte = false;
    caixa.querySelector(".nova-fonte input[name=fonteUrl]")?.focus();
  }

  // Guarda o que foi digitado: o quadro pode ser redesenhado com o formulário aberto.
  caixa.oninput = (e) => {
    if (e.target.closest(".form-lembrete") && e.target.name) lem.campos[e.target.name] = e.target.value;
  };

  caixa.onchange = (e) => {
    const alvo = e.target;
    if (alvo.matches("[data-arquivos]")) {
      lem.arquivos.push(...alvo.files);
      lem.erro = "";
      return redesenhar();
    }
    if (alvo.closest(".form-lembrete")) {
      if (alvo.name) lem.campos[alvo.name] = alvo.value;
      return;
    }
    const ds = alvo.dataset;
    const l = d.lembretes.find((x) => x.id === (ds.concluir || ds.reabrir));
    if (!l) return;
    l.concluidoEm = ds.concluir ? agora() : null;
    l.atualizadoEm = agora();
    marcarAlterado();
    setTimeout(redesenhar, ds.concluir ? 250 : 0); // deixa ver o "check" antes de mover
  };

  caixa.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || !caixa.contains(b)) return;
    const ds = b.dataset;
    if (ds.lemPasta) {
      fecharForms();
      lem.pasta = ds.lemPasta;
      return redesenhar();
    }
    if (ds.anexo) {
      const a = d.lembretes.find((x) => x.id === ds.de)?.anexos?.find((x) => x.id === ds.anexo);
      if (a) abrirAnexo(a);
      return;
    }
    if (ds.detalhes) {
      if (!lem.abertos.delete(ds.detalhes)) lem.abertos.add(ds.detalhes);
      return redesenhar();
    }
    if (ds.editar) {
      abrirFormLembrete(d.lembretes.find((x) => x.id === ds.editar));
      return redesenhar();
    }
    if (ds.tirarAnexo) { lem.remover.add(ds.tirarAnexo); return redesenhar(); }
    if (ds.tirarArquivo) { lem.arquivos.splice(Number(ds.tirarArquivo), 1); return redesenhar(); }
    if (ds.tirarFonte) { lem.campos.fontes.splice(Number(ds.tirarFonte), 1); return redesenhar(); }
    if (ds.mes !== undefined) {
      const n = Number(ds.mes);
      if (n === 0) { lem.mes = null; lem.dia = dataISO(); }
      else {
        const [a, m] = (lem.mes || dataISO().slice(0, 7)).split("-").map(Number);
        lem.mes = dataISO(new Date(a, m - 1 + n, 1)).slice(0, 7);
      }
      return redesenhar();
    }
    if (ds.dia) {
      lem.dia = lem.dia === ds.dia ? null : ds.dia;
      if (lem.dia && lem.dia.slice(0, 7) !== (lem.mes || dataISO().slice(0, 7))) lem.mes = lem.dia.slice(0, 7);
      return redesenhar();
    }
    if (ds.ir) return irParaLembrete(ds.ir);
    if (ds.excluir) {
      const l = d.lembretes.find((x) => x.id === ds.excluir);
      const n = l?.anexos?.length || 0;
      if (!l || !confirm(`Excluir de vez o lembrete “${l.texto}”${n ? ` e ${plural(n, "anexo", "anexos")}` : ""}?`)) return;
      d.lembretes = d.lembretes.filter((x) => x.id !== l.id);
      d.removidos[l.id] = agora();
      apagarAnexos((l.anexos || []).map((a) => a.id));
      marcarAlterado();
      return redesenhar();
    }
    switch (ds.lem) {
      case "voltar": fecharForms(); lem.pasta = null; break;
      case "nova-pasta": fecharForms(); Object.assign(lem, { form: "pasta", focar: true, campos: {} }); break;
      case "novo-lembrete": fecharForms(); abrirFormLembrete(); break;
      case "cancelar": fecharForms(); break;
      case "add-fonte":
        adicionarFonte();
        lem.focarFonte = true;
        break;
      case "editar-pasta":
        fecharForms();
        Object.assign(lem, { editandoPasta: pasta.id, focar: true, campos: { nome: pasta.nome, cor: pasta.cor || "" } });
        break;
      case "excluir-pasta": {
        const dentro = d.lembretes.filter((l) => l.pasta === pasta.id);
        const anexos = dentro.flatMap((l) => (l.anexos || []).map((a) => a.id));
        if (!confirm(`Excluir de vez a pasta “${pasta.nome}”${dentro.length ? ` e ${plural(dentro.length, "lembrete", "lembretes")} dentro dela` : ""}${anexos.length ? ` (com ${plural(anexos.length, "anexo", "anexos")})` : ""}?`)) return;
        const t = agora();
        for (const l of dentro) d.removidos[l.id] = t;
        d.lembretes = d.lembretes.filter((l) => l.pasta !== pasta.id);
        d.pastasLembretes = d.pastasLembretes.filter((p) => p.id !== pasta.id);
        d.removidos[pasta.id] = t;
        apagarAnexos(anexos);
        fecharForms();
        lem.pasta = null;
        marcarAlterado();
        break;
      }
      default: return;
    }
    redesenhar();
  };
}

// ── Cabeçalho ("X lembretes") e rodapé de alertas (! e !!) ──

function atualizarAvisosLembretes() {
  if (!estado.dados) return;
  const n = lembretesPendentes().length;
  const topo = $("#topo-lembretes");
  if (topo) {
    topo.hidden = !n;
    topo.textContent = plural(n, "lembrete", "lembretes");
    topo.title = `${plural(n, "lembrete pendente", "lembretes pendentes")}`;
  }
  const rodape = $("#alertas");
  if (!rodape) return;
  const alertas = lembretesPendentes().map((l) => ({ l, a: alertaDe(l) })).filter((x) => x.a)
    .sort((x, y) => y.a.nivel - x.a.nivel || x.a.dias - y.a.dias);
  rodape.hidden = !alertas.length;
  rodape.innerHTML = alertas.map(({ l, a }) => `
    <button type="button" class="alerta nivel-${a.nivel} cor-${l.cor || "nenhuma"}" data-alerta="${esc(l.id)}" title="${esc(`${a.tipo === "data limite" ? "Data limite para conclusão" : "Previsão de conclusão"}: ${dataCurta(a.data)}`)}">
      <span class="marca-alerta nivel-${a.nivel}">${a.nivel === 2 ? "!!" : "!"}</span>
      <span class="alerta-texto">${esc(l.texto)}</span>
      <span class="alerta-prazo">${esc(a.tipo)} ${esc(prazoTexto(a.dias))}</span>
    </button>`).join("");
}

function paginaPasta(el) {
  const p = pastaPorId(estado.pastaAtual);
  if (!p) return abrirInicio();
  const textos = textosDaPasta(p.id);
  el.innerHTML = `
    <div class="pagina">
      <div class="pagina-topo">
        <div class="titulo-pasta"><h1>📓 ${esc(p.nome)}</h1>${menuAcoes("renomear-pasta", "pasta-lixeira")}</div>
      </div>
      <div class="acoes novo">
        <button class="botao primario" data-acao="novo-texto">+ Novo texto pontual</button>
        <button class="botao" data-acao="novo-diario">+ Novo texto contínuo</button>
        <span class="ajuda" tabindex="0" role="note" aria-label="${esc(AJUDA_TIPOS)}" data-dica="${esc(AJUDA_TIPOS)}">?</span>
      </div>
      ${textos.length ? `<ul class="lista-grande">${textos.map((t) => itemGrande(t)).join("")}</ul>` : `<p class="vazio">Nenhum texto neste caderno ainda.</p>`}
    </div>`;
}

function paginaBusca(el) {
  const r = resultadosDaBusca();
  el.innerHTML = `
    <div class="pagina">
      <div class="pagina-topo"><h1>Busca: “${esc(estado.busca)}”</h1></div>
      <p class="dica">${plural(r.length, "texto encontrado", "textos encontrados")}.</p>
      ${r.length ? `<ul class="lista-grande">${r.map((t) => itemGrande(t, true)).join("")}</ul>` : ""}
    </div>`;
}

function paginaLixeira(el) {
  const l = itensNaLixeira();
  const linha = (titulo, meta, botoes) => `
    <li class="linha-lixeira">
      <span class="item-corpo"><span class="item-titulo">${titulo}</span><span class="item-meta">${meta}</span></span>
      <span class="acoes">${botoes}</span>
    </li>`;
  const secao = (nome, itens) => (itens.length ? `<h2>${nome}</h2><ul class="lista-lixeira">${itens.join("")}</ul>` : "");
  const vazia = !l.pastas.length && !l.textos.length && !l.entradas.length;
  el.innerHTML = `
    <div class="pagina">
      <div class="pagina-topo"><h1>🗑 Lixeira</h1></div>
      <p class="dica">Os itens ficam aqui até você restaurar ou apagar definitivamente (pela setinha ▾).</p>
      ${vazia ? `<p class="vazio">A lixeira está vazia.</p>` : ""}
      ${secao("Cadernos", l.pastas.map((p) => linha(
        `📓 ${esc(p.nome)}`,
        `${plural(estado.dados.textos.filter((t) => t.pastaId === p.id).length, "texto", "textos")} dentro · enviado ${esc(quando(p.naLixeira))}`,
        menuLixeira("pasta", p.id))))}
      ${secao("Textos", l.textos.map((t) => linha(
        `${icone(t)} ${esc(t.titulo || "Sem título")}`,
        `do caderno ${esc(pastaPorId(t.pastaId)?.nome || "?")} · enviado ${esc(quando(t.naLixeira))}`,
        `<button class="botao pequeno" data-texto="${esc(t.id)}">Ver</button>${menuLixeira("texto", t.id)}`)))}
      ${secao("Entradas de texto contínuo", l.entradas.map(({ texto, entrada }) => linha(
        `📔 Entrada de ${esc(dataCurta(entrada.data))}, ${esc(entrada.hora)}`,
        `do texto contínuo “${esc(texto.titulo || "Sem título")}” · enviada ${esc(quando(entrada.naLixeira))}${textoDeHtml(entrada.corpo) ? ` · “${esc(textoDeHtml(entrada.corpo).slice(0, 60))}…”` : ""}`,
        menuLixeira("entrada", entrada.id, `data-diario="${esc(texto.id)}"`))))}
    </div>`;
}

// ── Página de um texto ──

function tocarTexto(t) {
  t.atualizadoEm = agora();
  marcarAlterado();
  renderizarPaineis();
}

function paginaTexto(el) {
  const t = textoPorId(estado.textoAtual);
  if (!t) return abrirInicio();
  const naLixeira = !textoAtivo(t);
  const modo = naLixeira ? "ler" : estado.modo;
  const escrever = modo === "escrever";
  const origem = naLixeira ? "Lixeira" : pastaPorId(t.pastaId)?.nome || "Voltar";
  const opcoesPasta = pastasAtivas().map((p) => `<option value="${esc(p.id)}" ${p.id === t.pastaId ? "selected" : ""}>${esc(p.nome)}</option>`).join("");

  el.innerHTML = `
    <div class="pagina pagina-texto" data-modo="${modo}">
      <div class="barra-texto">
        <button class="botao pequeno" data-acao="voltar">← ${esc(origem)}</button>
        ${naLixeira ? "" : `
        <span class="modos" role="group" aria-label="Modo">
          <button data-modo="escrever" class="${escrever ? "ativo" : ""}">Escrever</button><button data-modo="ler" class="${escrever ? "" : "ativo"}">Ler</button>
        </span>`}
        <span class="espaco"></span>
        <div class="menu-caixa">
          <button class="botao pequeno" data-acao="menu-exportar">Exportar ▾</button>
          <div class="menu-barra direita menu-flutuante" id="menu-exportar" hidden>
            <button class="menu-item" data-exportar="pdf">PDF</button>
            <button class="menu-item" data-exportar="docx">Word (.docx)</button>
            <button class="menu-item" data-exportar="txt">Texto (.txt)</button>
          </div>
        </div>
        ${naLixeira
          ? menuLixeira("texto", t.id)
          : menuAcoes("editar-texto", "texto-lixeira")}
      </div>
      ${naLixeira ? `<p class="aviso-lixeira">Este texto está na lixeira desde ${esc(quando(t.naLixeira))}. Restaure para voltar a editar.</p>` : ""}
      ${escrever ? `<div id="barra-formatacao"></div>` : ""}
      <div class="folha">
        <input class="titulo-texto documento" id="titulo-texto" value="${esc(t.titulo)}" placeholder="Título" ${escrever ? "" : "readonly"}>
        <div class="meta-texto" ${escrever ? "" : "hidden"}>
          <label>📓 <select id="mover-texto" ${naLixeira ? "disabled" : ""}>${opcoesPasta}</select></label>
          <span>${t.tipo === "diario" ? "📔 Texto contínuo" : "📄 Texto pontual"}</span>
          ${t.tipo === "diario" ? "" : `<label title="Quando o trabalho foi feito de fato (ex.: escrito à mão antes de passar para o caderno)">🗓 dia de execução <input type="date" id="execucao-texto" value="${esc(diaExecucao(t) || "")}" ${naLixeira ? "disabled" : ""}></label>`}
          <span>criado ${esc(quando(t.criadoEm))}</span>
          <span>editado ${esc(quando(t.atualizadoEm))}</span>
        </div>
        ${escrever ? "" : `<p class="datas-leitura">${datasDoTexto(t).map(([r, v]) => `<span><strong>${esc(r)}:</strong> ${esc(v)}</span>`).join("")}</p>`}
        ${t.tipo === "diario" ? (escrever ? `
          <details class="descricao" ${t.corpo ? "open" : ""}>
            <summary>Sobre</summary>
            <div id="corpo-texto"></div>
          </details>
          <div class="diario-topo">
            <button class="botao primario" data-acao="nova-entrada">+ Nova entrada</button>
          </div>
          <div class="pagina-entrada" id="entradas"></div>` : `
          <div class="rt-leitura">
            <div class="sobre" id="corpo-texto"></div>
            <div id="entradas"></div>
          </div>`)
        : `<div id="corpo-texto"></div>`}
      </div>
    </div>`;

  if (escrever) montarBarra($("#barra-formatacao"));

  const titulo = $("#titulo-texto");
  titulo.addEventListener("input", () => { t.titulo = titulo.value; tocarTexto(t); });
  $("#execucao-texto")?.addEventListener("change", (e) => {
    if (!e.target.value) { e.target.value = diaExecucao(t) || ""; return; } // não fica sem data
    t.execucao = e.target.value;
    tocarTexto(t);
  });
  $("#mover-texto").addEventListener("change", (e) => {
    t.pastaId = e.target.value;
    estado.pastaAtual = t.pastaId;
    tocarTexto(t);
    $("[data-acao='voltar']").textContent = `← ${pastaPorId(t.pastaId).nome}`;
  });

  montarEditor($("#corpo-texto"), {
    html: t.corpo,
    editavel: escrever,
    placeholder: t.tipo === "diario" ? "Objetivo do texto, perguntas da revisão, palavras-chave…" : "Comece a escrever…",
    aoMudar: (html) => { t.corpo = html; tocarTexto(t); },
  });

  if (t.tipo === "diario") renderizarPaginaEntrada(t, escrever);
}

// Texto contínuo: cada entrada é uma "página" (em Escrever e em Ler), com
// setinhas para ir à anterior/próxima. As exportações continuam com o texto
// corrido (todas as entradas em sequência).
const paginaDoDiario = {}; // id do texto → id da entrada aberta (padrão: a mais recente)

function renderizarPaginaEntrada(t, escrever) {
  const caixa = $("#entradas");
  const entradas = entradasAtivas(t).reverse(); // ordem cronológica: nº 1 é a mais antiga
  if (!escrever && !t.corpo) $("#corpo-texto").hidden = true;
  if (!entradas.length) {
    caixa.innerHTML = `<p class="vazio">Nenhuma entrada ainda.${escrever ? " Clique em “+ Nova entrada” para registrar a primeira." : ""}</p>`;
    return;
  }
  let i = entradas.findIndex((e) => e.id === paginaDoDiario[t.id]);
  if (i < 0) i = entradas.length - 1;
  const en = entradas[i];
  paginaDoDiario[t.id] = en.id;
  const total = entradas.length;
  const ir = (j) => {
    paginaDoDiario[t.id] = entradas[j].id;
    renderizarPaginaEntrada(t, escrever);
    caixa.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const navegacao = (embaixo) => `
    <nav class="paginas-entradas${embaixo ? " embaixo" : ""}" aria-label="Entradas">
      <button type="button" class="pag" data-pag="${i - 1}" ${i === 0 ? "disabled" : ""} title="Entrada anterior" aria-label="Entrada anterior">‹${embaixo ? " Anterior" : ""}</button>
      ${embaixo ? `<span class="pag-onde">Entrada ${i + 1} de ${total}</span>` : `
      <select class="ir-entrada" aria-label="Ir para a entrada">
        ${entradas.map((e, j) => `<option value="${j}" ${j === i ? "selected" : ""}>Entrada nº ${j + 1} — ${esc(dataCurta(e.data))}, ${esc(e.hora)}</option>`).join("")}
      </select>
      <span class="pag-onde">de ${total}</span>`}
      <button type="button" class="pag" data-pag="${i + 1}" ${i === total - 1 ? "disabled" : ""} title="Próxima entrada" aria-label="Próxima entrada">${embaixo ? "Próxima " : ""}›</button>
    </nav>`;

  caixa.innerHTML = navegacao(false) + (escrever ? `
    <article class="entrada" data-entrada="${esc(en.id)}">
      <div class="entrada-cabeca">
        <span class="entrada-num">nº ${i + 1}</span>
        <input type="date" class="entrada-data" value="${esc(en.data)}" title="Data">
        <input type="time" class="entrada-hora" value="${esc(en.hora)}" title="Hora">
        ${i === total - 1 ? `<span class="selo">mais recente</span>` : ""}
        <span class="espaco"></span>
        ${menuAcoes("entrada-editar", "entrada-lixeira", `data-entrada-id="${esc(en.id)}"`)}
      </div>
      <div class="entrada-texto"></div>
    </article>` : `
    <h2 class="titulo-entrada">Entrada nº ${i + 1} — ${esc(dataLonga(en.data))}, ${esc(en.hora)}</h2>
    <div class="entrada-texto"></div>`) + (total > 1 ? navegacao(true) : "");

  caixa.querySelectorAll("[data-pag]").forEach((b) => b.addEventListener("click", () => ir(Number(b.dataset.pag))));
  caixa.querySelector(".ir-entrada").addEventListener("change", (e) => ir(Number(e.target.value)));

  montarEditor(caixa.querySelector(".entrada-texto"), {
    html: en.corpo,
    editavel: escrever,
    placeholder: escrever ? "O que você leu ou fez? Referências, achados, próximos passos…" : "",
    aoMudar: (html) => { en.corpo = html; en.atualizadoEm = agora(); tocarTexto(t); },
  });
  if (!escrever) return;

  const art = caixa.querySelector(".entrada");
  const reordenar = () => { tocarTexto(t); renderizarPaginaEntrada(t, true); };
  art.querySelector(".entrada-data").addEventListener("change", (e) => { if (e.target.value) { en.data = e.target.value; en.atualizadoEm = agora(); reordenar(); } });
  art.querySelector(".entrada-hora").addEventListener("change", (e) => { if (e.target.value) { en.hora = e.target.value; en.atualizadoEm = agora(); reordenar(); } });
  art.querySelector("[data-acao='entrada-editar']").addEventListener("click", () => {
    const corpo = art.querySelector(".entrada-texto");
    corpo.focus();
    const r = document.createRange();
    r.selectNodeContents(corpo);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  art.querySelector("[data-acao='entrada-lixeira']").addEventListener("click", () => {
    en.naLixeira = agora();
    en.atualizadoEm = agora();
    paginaDoDiario[t.id] = (entradas[i + 1] || entradas[i - 1])?.id; // fica na vizinha
    tocarTexto(t);
    renderizarPaginaEntrada(t, true);
    avisar(`Entrada de ${dataCurta(en.data)}, ${en.hora} enviada para a lixeira.`, () => {
      en.naLixeira = null;
      en.atualizadoEm = agora();
      paginaDoDiario[t.id] = en.id;
      tocarTexto(t);
      if (estado.textoAtual === t.id) renderizarPrincipal();
    });
  });
}

function editarTexto() {
  if (estado.modo !== "escrever") {
    estado.modo = "escrever";
    gravarLS("caderno.modo", "escrever");
    const rolagem = $("#principal").scrollTop;
    renderizarPrincipal();
    $("#principal").scrollTop = rolagem;
  }
  const t = textoPorId(estado.textoAtual);
  (t?.tipo === "diario" || !t?.titulo ? $("#titulo-texto") : $("#corpo-texto"))?.focus();
}

function novaEntrada(t) {
  if (estado.modo !== "escrever") {
    estado.modo = "escrever";
    gravarLS("caderno.modo", "escrever");
  }
  const d = new Date();
  const en = { id: novoId("entrada"), data: dataISO(d), hora: horaISO(d), corpo: "", criadoEm: agora(), atualizadoEm: agora() };
  t.entradas ||= [];
  t.entradas.push(en);
  paginaDoDiario[t.id] = en.id;
  tocarTexto(t);
  renderizarPrincipal();
  const art = document.querySelector(`[data-entrada="${en.id}"]`);
  art?.scrollIntoView({ behavior: "smooth", block: "center" });
  art?.querySelector(".entrada-texto")?.focus();
}

function novoTexto(tipo) {
  const pastaId = estado.pastaAtual;
  if (!pastaPorId(pastaId)) return;
  const t = agora();
  const texto = {
    id: novoId("texto"), pastaId, tipo, formato: "html",
    titulo: tipo === "diario" ? `Texto contínuo — ${new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}` : "",
    corpo: "", entradas: tipo === "diario" ? [] : undefined,
    execucao: tipo === "diario" ? undefined : dataISO(),
    criadoEm: t, atualizadoEm: t,
  };
  estado.dados.textos.push(texto);
  marcarAlterado();
  if (estado.modo !== "escrever") { estado.modo = "escrever"; gravarLS("caderno.modo", "escrever"); }
  abrirTexto(texto.id);
  const titulo = $("#titulo-texto");
  titulo.focus();
  if (tipo === "diario") titulo.select();
}

// ── Lixeira ──

function textoParaLixeira(t) {
  t.naLixeira = agora();
  t.atualizadoEm = agora();
  marcarAlterado();
  const pasta = t.pastaId;
  abrirPasta(pasta);
  avisar(`“${t.titulo || "Sem título"}” foi para a lixeira.`, () => restaurarTexto(t.id, false));
}

function pastaParaLixeira(p) {
  p.naLixeira = agora();
  p.atualizadoEm = agora();
  marcarAlterado();
  abrirInicio();
  avisar(`O caderno “${p.nome}” foi para a lixeira (com os textos dele).`, () => restaurarPasta(p.id));
}

// ── Apagar definitivamente (só a partir da lixeira) ──

const AVISO_APAGAR = "Tem certeza que deseja excluir definitivamente? Caso seja um documento que pode ser utilizado posteriormente, mesmo que haja poucas chances, é adequado manter por precaução. Às vezes eu utilizo dados de anos atrás :)";

function confirmarApagar(oque) {
  return confirm(`${oque}\n\n${AVISO_APAGAR}`);
}

function depoisDeApagar(msg) {
  marcarAlterado();
  if (estado.pagina === "lixeira") { renderizarPaineis(); renderizarPrincipal(); }
  else abrirLixeira();
  avisar(msg);
}

function apagarPasta(id) {
  const p = pastaPorId(id);
  if (!p) return;
  const dentro = estado.dados.textos.filter((t) => t.pastaId === id);
  const extra = !dentro.length ? ""
    : dentro.length === 1 ? " O texto que está dentro dele também será apagado."
    : ` Os ${dentro.length} textos que estão dentro dele também serão apagados.`;
  if (!confirmarApagar(`Apagar definitivamente o caderno “${p.nome}”?${extra}`)) return;
  const t = agora();
  estado.dados.pastas = estado.dados.pastas.filter((x) => x.id !== id);
  estado.dados.textos = estado.dados.textos.filter((x) => x.pastaId !== id);
  estado.dados.removidos[id] = t;
  for (const x of dentro) estado.dados.removidos[x.id] = t;
  depoisDeApagar(`O caderno “${p.nome}” foi apagado definitivamente.`);
}

function apagarTexto(id) {
  const t = textoPorId(id);
  if (!t) return;
  if (!confirmarApagar(`Apagar definitivamente “${t.titulo || "Sem título"}”?`)) return;
  estado.dados.textos = estado.dados.textos.filter((x) => x.id !== id);
  estado.dados.removidos[id] = agora();
  if (estado.textoAtual === id) estado.textoAtual = null;
  depoisDeApagar(`“${t.titulo || "Sem título"}” foi apagado definitivamente.`);
}

function apagarEntrada(diarioId, entradaId) {
  const t = textoPorId(diarioId);
  const en = t?.entradas?.find((e) => e.id === entradaId);
  if (!en) return;
  if (!confirmarApagar(`Apagar definitivamente a entrada de ${dataCurta(en.data)}, ${en.hora}, do texto contínuo “${t.titulo || "Sem título"}”?`)) return;
  t.entradas = t.entradas.filter((e) => e.id !== entradaId);
  t.atualizadoEm = agora();
  depoisDeApagar("A entrada foi apagada definitivamente.");
}

function restaurarPasta(id) {
  const p = pastaPorId(id);
  if (!p) return;
  p.naLixeira = null;
  p.atualizadoEm = agora();
  marcarAlterado();
  renderizarPaineis();
  renderizarPrincipal();
  avisar(`Caderno “${p.nome}” restaurado.`);
}

function restaurarTexto(id, abrir = true) {
  const t = textoPorId(id);
  if (!t) return;
  t.naLixeira = null;
  t.atualizadoEm = agora();
  let p = pastaPorId(t.pastaId);
  if (!p) {
    p = pastasAtivas()[0] || criarPasta("Restaurados");
    t.pastaId = p.id;
  }
  if (p.naLixeira) { p.naLixeira = null; p.atualizadoEm = agora(); }
  marcarAlterado();
  if (abrir) abrirTexto(t.id);
  else { renderizarPaineis(); renderizarPrincipal(); }
  avisar(`“${t.titulo || "Sem título"}” restaurado em ${p.nome}.`);
}

function restaurarEntrada(diarioId, entradaId) {
  const t = textoPorId(diarioId);
  const en = t?.entradas?.find((e) => e.id === entradaId);
  if (!en) return;
  en.naLixeira = null;
  en.atualizadoEm = agora();
  tocarTexto(t);
  renderizarPrincipal();
  avisar(`Entrada restaurada no texto contínuo “${t.titulo || "Sem título"}”.`);
}

function criarPasta(nome) {
  const t = agora();
  const p = { id: novoId("pasta"), nome, criadoEm: t, atualizadoEm: t };
  estado.dados.pastas.push(p);
  marcarAlterado();
  return p;
}

function novaPasta() {
  const nome = prompt("Nome do novo caderno:");
  if (!nome?.trim()) return;
  abrirPasta(criarPasta(nome.trim()).id);
}

async function exportar(formato) {
  const t = textoPorId(estado.textoAtual);
  if (!t) return;
  try {
    if (formato === "pdf") exportarPdf(t);
    else if (formato === "txt") exportarTxt(t);
    else await exportarDocx(t);
  } catch (e) {
    alert(`Não foi possível exportar: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Eventos do aplicativo
// ---------------------------------------------------------------------------

let timerBusca = null;
let timerRolagem = null;

function configurarApp() {
  $("#ir-inicio").addEventListener("click", abrirInicio);
  $("#voltar-inicio").addEventListener("click", abrirInicio);
  $("#abrir-lixeira").addEventListener("click", abrirLixeira);
  $("#nova-pasta").addEventListener("click", novaPasta);
  $("#salvar").addEventListener("click", () => salvar());
  $("#abrir-gaveta").addEventListener("click", () => ($("#app").classList.contains("gaveta-aberta") ? fecharGaveta() : abrirGaveta()));
  $("#fundo-gaveta").addEventListener("click", fecharGaveta);

  document.querySelectorAll("[data-painel]").forEach((b) => b.addEventListener("click", () => alternarPainel(b.dataset.painel)));

  $("#lista-pastas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pasta]");
    if (b) abrirPasta(b.dataset.pasta);
  });
  $("#lista-textos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-texto]");
    if (b) abrirTexto(b.dataset.texto);
  });
  $("#busca").addEventListener("input", (e) => {
    clearTimeout(timerBusca);
    timerBusca = setTimeout(() => buscar(e.target.value), 250);
  });

  // "X lembretes" no topo e alertas (! / !!) no rodapé levam aos lembretes.
  $("#topo-lembretes").addEventListener("click", () => {
    if (estado.pagina !== "inicio") abrirInicio();
    $("#lembretes")?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  $("#alertas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-alerta]");
    if (b) irParaLembrete(b.dataset.alerta);
  });

  // Cliques na área principal (o conteúdo é redesenhado a cada página).
  $("#principal").addEventListener("click", (e) => {
    const alvo = e.target.closest("button, [data-pasta], [data-texto]");
    if (alvo?.dataset.acao === "abrir-menu" || alvo?.dataset.acao === "menu-exportar") {
      const menu = alvo.parentElement.querySelector(".menu-flutuante");
      fecharMenus(menu);
      menu.hidden = !menu.hidden;
      alvo.setAttribute("aria-expanded", String(!menu.hidden));
      return;
    }
    fecharMenus();
    if (!alvo) return;
    const d = alvo.dataset;
    const t = textoPorId(estado.textoAtual);
    if (d.restaurarPasta) return restaurarPasta(d.restaurarPasta);
    if (d.restaurarTexto) return restaurarTexto(d.restaurarTexto);
    if (d.restaurarEntrada) return restaurarEntrada(d.diario, d.restaurarEntrada);
    if (d.apagarPasta) return apagarPasta(d.apagarPasta);
    if (d.apagarTexto) return apagarTexto(d.apagarTexto);
    if (d.apagarEntrada) return apagarEntrada(d.diario, d.apagarEntrada);
    if (d.exportar) return exportar(d.exportar);
    if (d.modo) {
      estado.modo = d.modo;
      gravarLS("caderno.modo", d.modo);
      const rolagem = $("#principal").scrollTop;
      renderizarPrincipal();
      $("#principal").scrollTop = rolagem;
      return;
    }
    switch (d.acao) {
      case "voltar": return voltar();
      case "nova-pasta": return novaPasta();
      case "abrir-lixeira": return abrirLixeira();
      case "novo-texto": return novoTexto("texto");
      case "novo-diario": return novoTexto("diario");
      case "nova-entrada": return novaEntrada(t);
      case "texto-lixeira": return textoParaLixeira(t);
      case "pasta-lixeira": return pastaParaLixeira(pastaPorId(estado.pastaAtual));
      case "editar-texto": return editarTexto();
      case "renomear-pasta": {
        const p = pastaPorId(estado.pastaAtual);
        const nome = prompt("Novo nome do caderno:", p.nome);
        if (!nome?.trim()) return;
        p.nome = nome.trim();
        p.atualizadoEm = agora();
        marcarAlterado();
        renderizarPaineis();
        return renderizarPrincipal();
      }
    }
    if (d.pasta) return abrirPasta(d.pasta);
    if (d.info) {
      if (!infoAberta.delete(d.info)) infoAberta.add(d.info);
      const rolagem = $("#principal").scrollTop;
      renderizarPrincipal();
      $("#principal").scrollTop = rolagem;
      return;
    }
    if (d.texto && d.abrir) {
      estado.modo = d.abrir;
      gravarLS("caderno.modo", d.abrir);
    }
    if (d.texto) return abrirTexto(d.texto);
  });

  $("#principal").addEventListener("scroll", () => {
    clearTimeout(timerRolagem);
    timerRolagem = setTimeout(salvarPosicao, 400);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && estado.chave) {
      e.preventDefault();
      salvar();
    }
    if (e.key === "Escape") { fecharGaveta(); fecharMenus(); }
  });

  // Nunca perder nada: cópia local imediata ao sair/esconder a aba,
  // reenvio quando a internet voltar.
  const guardarJa = () => {
    if (!estado.chave || !estado.pendente) return;
    clearTimeout(timerRascunho);
    guardarRascunho(estado.chave, estado.dados);
    salvarPosicao();
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") guardarJa(); });
  window.addEventListener("pagehide", guardarJa);
  window.addEventListener("online", () => { if (estado.pendente) salvar(); });
  window.addEventListener("beforeunload", (e) => {
    if (estado.pendente || estado.salvando) { guardarJa(); e.preventDefault(); e.returnValue = ""; }
  });

  configurarDialogoConfig();
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
// Configurações
// ---------------------------------------------------------------------------

function msgConfig(texto, erro = false) {
  const el = $("#msg-config");
  el.textContent = texto;
  el.className = `msg ${erro ? "erro" : "ok"}`;
  el.hidden = !texto;
}

function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  gravarLS("caderno.tema", tema);
  document.querySelectorAll("#escolher-tema [data-tema]").forEach((b) => b.classList.toggle("ativo", b.dataset.tema === tema));
}

function configurarDialogoConfig() {
  const dlg = $("#dialogo-config");

  aplicarTema(document.documentElement.dataset.tema === "escuro" ? "escuro" : "claro");
  $("#escolher-tema").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tema]");
    if (b) aplicarTema(b.dataset.tema);
  });

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
    baixarArquivo(`caderno-backup-${dataISO()}.json`, JSON.stringify({ formato: "caderno-backup", exportadoEm: agora(), ...estado.dados }, null, 2), "application/json");
  });

  $("#importar").addEventListener("change", async (e) => {
    const arquivo = e.target.files[0];
    e.target.value = "";
    if (!arquivo) return;
    try {
      const b = JSON.parse(await arquivo.text());
      if (b.formato !== "caderno-backup" || !Array.isArray(b.pastas) || !Array.isArray(b.textos)) throw new Error("Este arquivo não é um backup do Caderno.");
      if (!confirm(`Juntar o backup (${b.pastas.length} cadernos, ${b.textos.length} textos) ao que já existe? Em textos repetidos, vale a versão editada por último.`)) return;
      const importados = { pastas: b.pastas, textos: b.textos, lembretes: b.lembretes || [], pastasLembretes: b.pastasLembretes || [], removidos: {} };
      migrar(importados);
      estado.dados = mesclarDados(estado.dados, importados);
      marcarAlterado();
      renderizarPaineis();
      renderizarPrincipal();
      msgConfig("Backup importado. Será enviado ao GitHub em instantes.");
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
