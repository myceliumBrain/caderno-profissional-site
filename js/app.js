import {
  novaChaveMestra, criarFechadura, abrirFechadura, cifrar, decifrar,
  novoCodigoRecuperacao, normalizarCodigo,
} from "./cripto.js";
import { lerPublico, GitHub, ErroConflito, ErroAcesso } from "./armazenamento.js";
import { mesclarDados } from "./mesclar.js";
import { CONFIG } from "./config.js";
import {
  $, agora, novoId, esc, dataISO, horaISO, dataLonga, dataCurta, quando,
  semAcento, textoDeHtml, plural, baixarArquivo,
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

function resumo(t) {
  const fonte = t.tipo === "diario" ? (entradasAtivas(t)[0]?.corpo || t.corpo) : t.corpo;
  return textoDeHtml(fonte).slice(0, 140);
}

function metaDoTexto(t, comPasta = false) {
  const partes = [`editado ${quando(t.atualizadoEm)}`];
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

function itemGrande(t, comPasta = false) {
  const r = resumo(t);
  return `
    <li><button class="item-grande" data-texto="${esc(t.id)}">
      <span class="item-icone">${icone(t)}</span>
      <span class="item-corpo">
        <span class="item-titulo">${esc(t.titulo || "Sem título")}</span>
        <span class="item-meta">${esc(metaDoTexto(t, comPasta))}</span>
        ${r ? `<span class="item-resumo">${esc(r)}</span>` : ""}
      </span>
    </button></li>`;
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
// Pendentes ficam no topo; concluídos vão para "Concluídos", onde podem
// voltar ou ser excluídos de vez (os únicos itens que o caderno apaga).

const CORES_LEMBRETE = [
  { id: "vermelho", rotulo: "Prioritário" },
  { id: "azul", rotulo: "Intelectual" },
  { id: "verde", rotulo: "Rotina" },
  { id: "amarelo", rotulo: "Social" },
];
const rotuloCor = (c) => CORES_LEMBRETE.find((x) => x.id === c)?.rotulo || "";
const lem = { pasta: null, form: null, editandoPasta: null }; // estado do quadro

function escolherCor(nome, atual) {
  const opcoes = [{ id: "", rotulo: "Sem cor" }, ...CORES_LEMBRETE];
  return `
    <div class="escolher-cor" role="radiogroup" aria-label="Cor">
      ${opcoes.map((c) => `
        <label class="opcao-cor" title="${esc(c.rotulo)}">
          <input type="radio" name="${nome}" value="${c.id}" ${c.id === (atual || "") ? "checked" : ""}>
          <span class="bolinha cor-${c.id || "nenhuma"}"></span><span>${esc(c.rotulo)}</span>
        </label>`).join("")}
    </div>`;
}

function itemLembrete(l, feito) {
  const cor = l.cor ? ` cor-${l.cor}` : "";
  return `
    <li class="${feito ? "feito" : ""}${cor}" data-lembrete="${esc(l.id)}">
      <label class="lembrete">
        <input type="checkbox" ${feito ? `checked data-reabrir="${esc(l.id)}" title="Voltar para pendentes"` : `data-concluir="${esc(l.id)}" title="Marcar como concluído"`}>
        <span class="lembrete-corpo">
          <span class="lembrete-texto">${esc(l.texto)}</span>
          <span class="lembrete-meta">${l.cor ? `<span class="etiqueta-cor cor-${l.cor}">${esc(rotuloCor(l.cor))}</span> ` : ""}${feito ? `concluído ${esc(quando(l.concluidoEm))}` : esc(quando(l.criadoEm))}</span>
        </span>
      </label>
      ${feito ? `<button class="excluir-lembrete" type="button" data-excluir="${esc(l.id)}" title="Excluir de vez">Excluir</button>` : ""}
    </li>`;
}

function montarLembretes(caixa) {
  const d = estado.dados;
  const pasta = lem.pasta && d.pastasLembretes.find((p) => p.id === lem.pasta);
  if (!pasta) lem.pasta = null;
  // Lembrete cuja pasta sumiu (ex.: excluída em outro aparelho) aparece na raiz.
  const ids = new Set(d.pastasLembretes.map((p) => p.id));
  const pastaDe = (l) => (l.pasta && ids.has(l.pasta) ? l.pasta : null);
  const daqui = d.lembretes.filter((l) => pastaDe(l) === lem.pasta);
  const pendentes = daqui.filter((l) => !l.concluidoEm)
    .sort((a, b) => (a.criadoEm || "").localeCompare(b.criadoEm || ""));
  const concluidos = daqui.filter((l) => l.concluidoEm)
    .sort((a, b) => b.concluidoEm.localeCompare(a.concluidoEm));
  const pendentesDa = (id) => d.lembretes.filter((l) => l.pasta === id && !l.concluidoEm).length;
  const pastas = pasta ? [] : [...d.pastasLembretes].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const abertos = lerLS("caderno.concluidos") === "1";
  const editando = lem.editandoPasta && d.pastasLembretes.find((p) => p.id === lem.editandoPasta);

  let form = "";
  if (lem.form === "lembrete") {
    form = `
      <form class="form-lembrete" data-form="lembrete" autocomplete="off">
        <input name="texto" maxlength="300" placeholder="Novo lembrete…" aria-label="Novo lembrete">
        ${escolherCor("cor", pasta?.cor || "")}
        <div class="form-botoes">
          <button class="botao pequeno" type="button" data-lem="cancelar">Cancelar</button>
          <button class="botao primario pequeno" type="submit">Adicionar</button>
        </div>
      </form>`;
  } else if (lem.form === "pasta" || editando) {
    form = `
      <form class="form-lembrete" data-form="pasta" autocomplete="off">
        <input name="nome" maxlength="80" placeholder="Nome da pasta (ex.: Laboratório)" aria-label="Nome da pasta" value="${esc(editando?.nome || "")}">
        ${escolherCor("cor", editando?.cor || "")}
        <div class="form-botoes">
          <button class="botao pequeno" type="button" data-lem="cancelar">Cancelar</button>
          <button class="botao primario pequeno" type="submit">${editando ? "Salvar" : "Criar pasta"}</button>
        </div>
      </form>`;
  }

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
    </details>` : ""}`;

  const redesenhar = () => montarLembretes(caixa);
  caixa.querySelector(".form-lembrete input[type=text], .form-lembrete input:not([type])")?.focus();

  caixa.querySelector(".form-lembrete")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const cor = f.querySelector("input[name=cor]:checked")?.value || null;
    const t = agora();
    if (f.dataset.form === "lembrete") {
      const texto = f.texto.value.trim();
      if (!texto) return;
      d.lembretes.push({ id: novoId("lembrete"), texto, cor, pasta: lem.pasta, criadoEm: t, atualizadoEm: t, concluidoEm: null });
      marcarAlterado();
      redesenhar(); // o formulário continua aberto para adicionar outro
    } else {
      const nome = f.nome.value.trim();
      if (!nome) return;
      if (editando) Object.assign(editando, { nome, cor, atualizadoEm: t });
      else d.pastasLembretes.push({ id: novoId("pastalem"), nome, cor, criadoEm: t, atualizadoEm: t });
      lem.form = null;
      lem.editandoPasta = null;
      marcarAlterado();
      redesenhar();
    }
  });
  caixa.querySelector("details.concluidos")?.addEventListener("toggle", (e) => gravarLS("caderno.concluidos", e.target.open ? "1" : "0"));

  caixa.onchange = (e) => {
    const ds = e.target.dataset;
    const l = d.lembretes.find((x) => x.id === (ds.concluir || ds.reabrir));
    if (!l) return;
    l.concluidoEm = ds.concluir ? agora() : null;
    l.atualizadoEm = agora();
    marcarAlterado();
    setTimeout(redesenhar, ds.concluir ? 250 : 0); // deixa ver o "check" antes de mover
  };

  caixa.onclick = (e) => {
    const b = e.target.closest("[data-lem], [data-lem-pasta], [data-excluir]");
    if (!b) return;
    if (b.dataset.lemPasta) {
      Object.assign(lem, { pasta: b.dataset.lemPasta, form: null, editandoPasta: null });
      return redesenhar();
    }
    if (b.dataset.excluir) {
      const l = d.lembretes.find((x) => x.id === b.dataset.excluir);
      if (!l || !confirm(`Excluir de vez o lembrete “${l.texto}”?`)) return;
      d.lembretes = d.lembretes.filter((x) => x.id !== l.id);
      d.removidos[l.id] = agora();
      marcarAlterado();
      return redesenhar();
    }
    switch (b.dataset.lem) {
      case "voltar": Object.assign(lem, { pasta: null, form: null, editandoPasta: null }); break;
      case "nova-pasta": Object.assign(lem, { form: "pasta", editandoPasta: null }); break;
      case "novo-lembrete": Object.assign(lem, { form: "lembrete", editandoPasta: null }); break;
      case "cancelar": Object.assign(lem, { form: null, editandoPasta: null }); break;
      case "editar-pasta": Object.assign(lem, { form: null, editandoPasta: lem.pasta }); break;
      case "excluir-pasta": {
        const n = d.lembretes.filter((l) => l.pasta === pasta.id).length;
        if (!confirm(`Excluir de vez a pasta “${pasta.nome}”${n ? ` e ${plural(n, "lembrete", "lembretes")} dentro dela` : ""}?`)) return;
        const t = agora();
        for (const l of d.lembretes) if (l.pasta === pasta.id) d.removidos[l.id] = t;
        d.lembretes = d.lembretes.filter((l) => l.pasta !== pasta.id);
        d.pastasLembretes = d.pastasLembretes.filter((p) => p.id !== pasta.id);
        d.removidos[pasta.id] = t;
        lem.pasta = null;
        marcarAlterado();
        break;
      }
      default: return;
    }
    redesenhar();
  };
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
          <span>criado ${esc(quando(t.criadoEm))}</span>
          <span>editado ${esc(quando(t.atualizadoEm))}</span>
        </div>
        ${t.tipo === "diario" ? (escrever ? `
          <details class="descricao" ${t.corpo ? "open" : ""}>
            <summary>Sobre</summary>
            <div id="corpo-texto"></div>
          </details>
          <div class="diario-topo">
            <button class="botao primario" data-acao="nova-entrada">+ Nova entrada</button>
          </div>
          <div class="linha-do-tempo" id="entradas"></div>` : `
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

  if (t.tipo === "diario") {
    if (escrever) renderizarEntradas(t);
    else renderizarLeitura(t);
  }
}

// Diário no modo Ler: igual ao PDF (ordem cronológica, título por entrada).
function renderizarLeitura(t) {
  if (!t.corpo) $("#corpo-texto").hidden = true;
  const caixa = $("#entradas");
  const entradas = entradasAtivas(t).reverse();
  if (!entradas.length) {
    caixa.innerHTML = `<p class="vazio">Nenhuma entrada ainda.</p>`;
    return;
  }
  caixa.innerHTML = "";
  entradas.forEach((en, i) => {
    const h = document.createElement("h2");
    h.className = "titulo-entrada";
    h.textContent = `Entrada nº ${i + 1} — ${dataLonga(en.data)}, ${en.hora}`;
    const corpo = document.createElement("div");
    caixa.append(h, corpo);
    montarEditor(corpo, {
      html: en.corpo,
      editavel: false,
      placeholder: "",
      aoMudar: (html) => { en.corpo = html; en.atualizadoEm = agora(); tocarTexto(t); },
    });
  });
}

function renderizarEntradas(t) {
  const escrever = true;
  const caixa = $("#entradas");
  const entradas = entradasAtivas(t);
  if (!entradas.length) {
    caixa.innerHTML = `<p class="vazio">Nenhuma entrada ainda. Clique em “+ Nova entrada” para registrar a primeira.</p>`;
    return;
  }
  caixa.innerHTML = "";
  const total = entradas.length;
  entradas.forEach((en, i) => {
    const art = document.createElement("article");
    art.className = "entrada";
    art.dataset.entrada = en.id;
    art.innerHTML = `
      <div class="entrada-cabeca">
        <span class="entrada-num">nº ${total - i}</span>
        ${escrever
          ? `<input type="date" class="entrada-data" value="${esc(en.data)}" title="Data">
             <input type="time" class="entrada-hora" value="${esc(en.hora)}" title="Hora">`
          : `<span class="entrada-quando"><strong>${esc(dataLonga(en.data))}</strong> · ${esc(en.hora)}</span>`}
        ${i === 0 ? `<span class="selo">mais recente</span>` : ""}
        <span class="espaco"></span>
        ${menuAcoes("entrada-editar", "entrada-lixeira", `data-entrada-id="${esc(en.id)}"`)}
      </div>
      <div class="entrada-texto"></div>`;
    caixa.appendChild(art);
    montarEditor(art.querySelector(".entrada-texto"), {
      html: en.corpo,
      editavel: escrever,
      placeholder: "O que você leu ou fez? Referências, achados, próximos passos…",
      aoMudar: (html) => { en.corpo = html; en.atualizadoEm = agora(); tocarTexto(t); },
    });
    if (escrever) {
      const reordenar = () => { tocarTexto(t); renderizarEntradas(t); };
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
        tocarTexto(t);
        renderizarEntradas(t);
        avisar(`Entrada de ${dataCurta(en.data)}, ${en.hora} enviada para a lixeira.`, () => {
          en.naLixeira = null;
          en.atualizadoEm = agora();
          tocarTexto(t);
          if (estado.textoAtual === t.id) renderizarPrincipal();
        });
      });
    }
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
