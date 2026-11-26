// Editor visual (contenteditable), no estilo do painel de notícias do
// astrobotanica. Os textos são guardados como HTML simples.
//
// Há UMA barra de formatação por página (montarBarra); ela age sobre o
// último editor em que o cursor esteve (corpo do texto, descrição ou
// entrada do diário).

// Tags e atributos aceitos no conteúdo.
const TAGS = ["p", "br", "h2", "h3", "strong", "b", "em", "i", "u", "small", "sub", "sup",
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "blockquote", "hr", "span"];
const ATRIBUTOS = ["href", "style", "class", "data-feito", "data-nova", "data-nota", "data-grupo", "colspan", "rowspan", "target", "rel"];

export function limparHtml(html) {
  if (!window.DOMPurify) return html || "";
  return DOMPurify.sanitize(html || "", { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATRIBUTOS });
}

// Ao colar (de Word, PDF, sites): mantém a estrutura, tira cores, fontes e estilos.
function limparColado(html) {
  if (!window.DOMPurify) return null;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: TAGS.filter((t) => t !== "a" && t !== "span"), ALLOWED_ATTR: ["colspan", "rowspan"] });
}

// Converte os textos antigos (Markdown) para o formato atual.
export function markdownParaHtml(md) {
  if (!md || !md.trim()) return "";
  if (!window.marked) return `<p>${md.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/\n/g, "<br>")}</p>`;
  const tpl = document.createElement("template");
  tpl.innerHTML = marked.parse(md, { gfm: true, breaks: true });
  tpl.content.querySelectorAll("li").forEach((li) => {
    const caixa = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
    if (!caixa) return;
    li.dataset.feito = caixa.checked ? "true" : "false";
    caixa.remove();
    li.parentElement.classList.add("tarefas");
  });
  tpl.content.querySelectorAll("h1").forEach((h) => { const n = document.createElement("h2"); n.innerHTML = h.innerHTML; h.replaceWith(n); });
  tpl.content.querySelectorAll("h4, h5, h6").forEach((h) => { const n = document.createElement("h3"); n.innerHTML = h.innerHTML; h.replaceWith(n); });
  return limparHtml(tpl.innerHTML);
}

// O navegador às vezes cria <div> no lugar de parágrafos: guarda sempre <p>
// (ou desembrulha o <div> quando ele contém listas/tabelas).
const BLOCOS = "p, h2, h3, ul, ol, table, blockquote, hr, div";
export function normalizar(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  let div;
  while ((div = tpl.content.querySelector("div"))) {
    if (div.querySelector(BLOCOS)) {
      div.replaceWith(...div.childNodes);
    } else {
      const p = document.createElement("p");
      if (div.getAttribute("style")) p.setAttribute("style", div.getAttribute("style"));
      p.append(...div.childNodes);
      div.replaceWith(p);
    }
  }
  // texto solto no primeiro nível vira parágrafo
  for (const no of [...tpl.content.childNodes]) {
    if (no.nodeType === 3 && no.textContent.trim()) {
      const p = document.createElement("p");
      no.replaceWith(p);
      p.appendChild(no);
    }
  }
  return tpl.innerHTML;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

let editorAtivo = null;
let intervaloSalvo = null;

const sel = () => window.getSelection();
const elementoDe = (no) => (no ? (no.nodeType === 1 ? no : no.parentElement) : null);

function estaVazio(el) {
  return !el.textContent.trim() && !el.querySelector("table, li, hr");
}

function atualizarVazio(el) {
  el.classList.toggle("vazio", estaVazio(el));
}

// ── Notas na margem ──
// Uma nota pode cobrir várias linhas e parágrafos: cada pedaço do texto fica
// num <span class="nota" data-nota="…" data-grupo="…">, e os pedaços do mesmo
// grupo viram UMA barra na margem (da primeira à última linha), com o texto
// da nota escrito uma vez só. Notas antigas, sem grupo, juntam-se quando
// pedaços seguidos têm o mesmo texto.
export function gruposDeNotas(raiz) {
  const grupos = new Map();
  let anterior = null;
  raiz.querySelectorAll("span.nota").forEach((s, i) => {
    let chave = s.dataset.grupo;
    if (!chave) {
      chave = anterior && !anterior.dataset.grupo && anterior.dataset.nota === s.dataset.nota ? anterior._grupo : `solto-${i}`;
    }
    s._grupo = chave;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(s);
    anterior = s;
  });
  return [...grupos.values()];
}

// Desenha as barras e os textos das notas na camada ao lado do texto.
export function desenharNotas(rt, camada) {
  const doc = camada.ownerDocument;
  camada.innerHTML = "";
  const grupos = gruposDeNotas(rt);
  rt.classList.toggle("com-notas", grupos.length > 0);
  if (!grupos.length) return;
  const base = camada.getBoundingClientRect().top;
  const posicoes = grupos.map((partes) => {
    let topo = Infinity, fundo = -Infinity;
    for (const p of partes) {
      for (const r of p.getClientRects()) {
        if (!r.width && !r.height) continue;
        topo = Math.min(topo, r.top);
        fundo = Math.max(fundo, r.bottom);
      }
    }
    return { partes, topo: topo - base, fundo: fundo - base };
  }).filter((g) => Number.isFinite(g.topo)).sort((a, b) => a.topo - b.topo);
  let fimTexto = -Infinity;
  for (const g of posicoes) {
    const barra = doc.createElement("div");
    barra.className = "nota-barra";
    barra.style.top = `${g.topo}px`;
    barra.style.height = `${Math.max(g.fundo - g.topo, 8)}px`;
    const texto = doc.createElement("div");
    texto.className = "nota-texto";
    texto.textContent = g.partes[0].dataset.nota || "";
    texto.style.top = `${Math.max(g.topo, fimTexto + 4)}px`; // não deixa uma nota cobrir a outra
    texto._partes = g.partes;
    camada.append(barra, texto);
    fimTexto = parseFloat(texto.style.top) + texto.offsetHeight;
  }
}

// Muda o texto de uma nota (todos os pedaços) ou, se vazio, tira a nota.
function editarNota(partes) {
  const texto = prompt("Nota na margem (deixe vazio para apagar a nota):", partes[0].dataset.nota || "");
  if (texto === null) return false;
  for (const p of partes) {
    if (texto.trim()) {
      p.dataset.nota = texto.trim();
    } else {
      const pai = p.parentNode;
      while (p.firstChild) pai.insertBefore(p.firstChild, p);
      p.remove();
      pai.normalize();
    }
  }
  return true;
}

function partesDaNota(span, raiz) {
  return gruposDeNotas(raiz).find((g) => g.includes(span)) || [span];
}

// Transforma um elemento em editor. Devolve funções para mudar o modo.
export function montarEditor(el, { html, editavel, placeholder, aoMudar }) {
  el.classList.add("rt", "documento");
  el.innerHTML = limparHtml(html);
  el.dataset.placeholder = placeholder || "";
  el.spellcheck = true;
  const definirEditavel = (sim) => { el.contentEditable = sim ? "true" : "false"; };
  definirEditavel(editavel);
  atualizarVazio(el);

  // Moldura com a camada das notas na margem direita.
  let camada = el.parentElement?.classList.contains("rt-moldura") ? el.nextElementSibling : null;
  if (!camada) {
    const moldura = document.createElement("div");
    moldura.className = "rt-moldura";
    el.before(moldura);
    camada = document.createElement("div");
    camada.className = "rt-notas";
    camada.setAttribute("aria-hidden", "true");
    moldura.append(el, camada);
  }
  let quadro = 0;
  const redesenharNotas = () => {
    cancelAnimationFrame(quadro);
    quadro = requestAnimationFrame(() => desenharNotas(el, camada));
  };
  new ResizeObserver(redesenharNotas).observe(el);
  document.fonts?.ready.then(redesenharNotas);
  redesenharNotas();

  const avisar = () => {
    atualizarVazio(el);
    redesenharNotas();
    aoMudar(estaVazio(el) ? "" : normalizar(el.innerHTML));
  };
  el.addEventListener("input", avisar);
  // Clicar no texto de uma nota (modo Escrever) edita ou apaga a nota.
  camada.addEventListener("click", (e) => {
    const t = e.target.closest(".nota-texto");
    if (!t || el.contentEditable !== "true") return;
    if (editarNota(t._partes)) avisar();
  });
  el.addEventListener("focus", () => {
    editorAtivo = el;
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch {}
    try { document.execCommand("enableInlineTableEditing", false, "false"); } catch {}
    if (!el.firstElementChild && !el.textContent) {
      el.innerHTML = "<p><br></p>";
      const r = document.createRange();
      r.setStart(el.firstChild, 0);
      sel().removeAllRanges();
      sel().addRange(r);
    }
  });
  el.addEventListener("paste", (e) => {
    if (el.contentEditable !== "true") return;
    const html = e.clipboardData.getData("text/html");
    if (!html) return; // texto puro: o navegador já cola certo
    const limpo = limparColado(html);
    if (limpo == null) return;
    e.preventDefault();
    document.execCommand("insertHTML", false, limpo);
  });
  // Lista de passos: clicar na caixinha marca/desmarca (também no modo Ler).
  el.addEventListener("click", (e) => {
    const li = e.target.closest?.("ul.tarefas > li");
    if (!li || !el.contains(li)) return;
    const caixa = li.getBoundingClientRect();
    if (e.clientX - caixa.left > 26) return; // só na caixinha (desenhada no recuo à esquerda)
    e.preventDefault();
    li.dataset.feito = li.dataset.feito === "true" ? "false" : "true";
    avisar();
  });
  return { el, definirEditavel };
}

// Guarda onde estava o cursor (os botões da barra tiram o foco do editor).
document.addEventListener("selectionchange", () => {
  const s = sel();
  if (!s.rangeCount) return;
  const el = elementoDe(s.anchorNode)?.closest(".rt");
  if (el && el.isContentEditable) {
    editorAtivo = el;
    intervaloSalvo = s.getRangeAt(0).cloneRange();
  }
  atualizarEstadoDaBarra();
});

function garantirCursor() {
  if (!editorAtivo || !document.body.contains(editorAtivo) || !editorAtivo.isContentEditable) {
    editorAtivo = document.querySelector(".rt[contenteditable='true']");
    intervaloSalvo = null;
    if (!editorAtivo) return false;
  }
  const s = sel();
  if (s.rangeCount && editorAtivo.contains(s.anchorNode)) return true;
  editorAtivo.focus();
  if (intervaloSalvo && editorAtivo.contains(intervaloSalvo.startContainer)) {
    s.removeAllRanges();
    s.addRange(intervaloSalvo);
  } else {
    if (!editorAtivo.lastChild) editorAtivo.innerHTML = "<p><br></p>";
    const r = document.createRange();
    r.selectNodeContents(editorAtivo.lastChild);
    r.collapse(false);
    s.removeAllRanges();
    s.addRange(r);
  }
  return true;
}

function avisarMudanca() {
  consertarListas();
  editorAtivo?.dispatchEvent(new Event("input", { bubbles: true }));
  atualizarEstadoDaBarra();
}

// Bloco de primeiro nível (filho direto do editor) onde está o cursor.
function blocoAtual() {
  let no = sel().anchorNode;
  if (!no || !editorAtivo?.contains(no) || no === editorAtivo) return null;
  while (no.parentNode !== editorAtivo) no = no.parentNode;
  return no;
}

function cmd(nome, valor = null) {
  document.execCommand(nome, false, valor);
}

function sairDaLista() {
  const li = elementoDe(sel().anchorNode)?.closest("li");
  if (li) cmd(li.parentElement.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
}

function alternarSubtitulo() {
  const atual = (document.queryCommandValue("formatBlock") || "").toLowerCase();
  sairDaLista();
  cmd("formatBlock", atual === "h3" ? "p" : "h3");
}

// Texto pequeno: envolve a seleção em <small> (ou a linha inteira, sem seleção).
function alternarPequeno() {
  const s = sel();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  const dentro = elementoDe(r.commonAncestorContainer)?.closest("small");
  if (dentro && editorAtivo.contains(dentro)) {
    const pai = dentro.parentNode;
    while (dentro.firstChild) pai.insertBefore(dentro.firstChild, dentro);
    dentro.remove();
    return;
  }
  const small = document.createElement("small");
  if (r.collapsed) {
    const bloco = blocoAtual();
    if (!bloco || bloco.nodeType !== 1 || bloco.tagName === "TABLE") return;
    const alvo = elementoDe(r.startContainer).closest("li, td, th, p, h2, h3") || bloco;
    while (alvo.firstChild) small.appendChild(alvo.firstChild);
    alvo.appendChild(small);
  } else {
    small.appendChild(r.extractContents());
    r.insertNode(small);
  }
  s.selectAllChildren(small);
}

function alternarPassos() {
  const li = elementoDe(sel().anchorNode)?.closest("li");
  const lista = li?.parentElement;
  if (lista?.tagName === "UL") {
    lista.classList.toggle("tarefas");
    if (lista.classList.contains("tarefas")) lista.querySelectorAll(":scope > li").forEach((x) => { x.dataset.feito ||= "false"; });
    return;
  }
  if (lista?.tagName === "OL") cmd("insertOrderedList");
  cmd("insertUnorderedList");
  const nova = elementoDe(sel().anchorNode)?.closest("ul");
  if (nova) {
    nova.classList.add("tarefas");
    nova.querySelectorAll(":scope > li").forEach((x) => { x.dataset.feito ||= "false"; });
  }
}

// ── Botão "✱ Nota" ──
function alternarNota() {
  const s = sel();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  const atual = elementoDe(r.startContainer)?.closest("span.nota");
  if (atual && editorAtivo.contains(atual) && (r.collapsed || atual.contains(r.endContainer))) {
    editarNota(partesDaNota(atual, editorAtivo));
    return;
  }
  if (r.collapsed || !r.toString().trim()) {
    alert("Selecione as palavras (podem ser várias linhas) que vão receber a nota.");
    return;
  }
  const texto = prompt("Nota na margem para o trecho selecionado (ex.: *, 2x, repetido):", "*");
  if (!texto?.trim()) return;
  // Envolve cada pedaço de texto da seleção, sem quebrar parágrafos nem listas.
  const raiz = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
  const { startContainer: ini, startOffset: oIni, endContainer: fim, endOffset: oFim } = r;
  const andar = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  const nos = [];
  while (andar.nextNode()) if (r.intersectsNode(andar.currentNode)) nos.push(andar.currentNode);
  const grupo = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let ultimo = null;
  for (const n of nos) {
    if (n.parentElement.closest("span.nota")) continue; // já tem nota
    const a = n === ini ? oIni : 0;
    const b = n === fim ? oFim : n.length;
    if (a >= b || !n.data.slice(a, b).trim()) continue;
    if (b < n.length) n.splitText(b);
    const pedaco = a > 0 ? n.splitText(a) : n;
    const span = document.createElement("span");
    span.className = "nota";
    span.dataset.nota = texto.trim();
    span.dataset.grupo = grupo;
    pedaco.replaceWith(span);
    span.appendChild(pedaco);
    ultimo = span;
  }
  if (ultimo) {
    const depois = document.createRange();
    depois.setStartAfter(ultimo);
    depois.collapse(true);
    s.removeAllRanges();
    s.addRange(depois);
  }
}

// ── Caixa com bordas (comentários) ──
function blocoDe(no) {
  if (!no || !editorAtivo?.contains(no) || no === editorAtivo) return null;
  while (no.parentNode !== editorAtivo) no = no.parentNode;
  return no;
}

function alternarCaixa() {
  const s = sel();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  const dentro = elementoDe(r.startContainer)?.closest("blockquote.caixa");
  if (dentro && editorAtivo.contains(dentro)) {
    dentro.replaceWith(...dentro.childNodes);
    return;
  }
  const inicio = blocoDe(r.startContainer);
  const fim = blocoDe(r.endContainer) || inicio;
  if (!inicio) return;
  const caixa = document.createElement("blockquote");
  caixa.className = "caixa";
  inicio.before(caixa);
  let no = inicio;
  while (no) {
    const prox = no === fim ? null : no.nextSibling;
    if (no.nodeType === 3) {
      if (no.textContent.trim()) { const p = document.createElement("p"); p.textContent = no.textContent; caixa.appendChild(p); }
      no.remove();
    } else caixa.appendChild(no);
    no = prox;
  }
  if (!caixa.firstChild) caixa.innerHTML = "<p><br></p>";
  // sempre deixa uma linha depois da caixa, para continuar escrevendo fora dela
  if (!caixa.nextSibling) {
    const p = document.createElement("p");
    p.appendChild(document.createElement("br"));
    caixa.after(p);
  }
  const fimR = document.createRange();
  fimR.selectNodeContents(caixa.lastChild);
  fimR.collapse(false);
  s.removeAllRanges();
  s.addRange(fimR);
}

// ── Tabelas ──
const celulaDoCursor = () => {
  const c = elementoDe(sel().anchorNode)?.closest("td, th");
  return c && editorAtivo?.contains(c) ? c : null;
};
const colunasDe = (tabela) => Math.max(1, ...[...tabela.querySelectorAll("tr")].map((tr) => tr.children.length));
const celulaVazia = (tag) => { const c = document.createElement(tag); c.appendChild(document.createElement("br")); return c; };
const linhaNova = (n) => { const tr = document.createElement("tr"); for (let i = 0; i < n; i++) tr.appendChild(celulaVazia("td")); return tr; };

function colocarCursorEm(no) {
  const r = document.createRange();
  r.selectNodeContents(no);
  r.collapse(true);
  sel().removeAllRanges();
  sel().addRange(r);
}

function novaTabela() {
  const tabela = document.createElement("table");
  const thead = tabela.createTHead();
  const cab = thead.insertRow();
  for (let i = 0; i < 3; i++) cab.appendChild(celulaVazia("th"));
  const tbody = tabela.createTBody();
  tbody.append(linhaNova(3), linhaNova(3));
  const depois = document.createElement("p");
  depois.appendChild(document.createElement("br"));

  const celula = celulaDoCursor();
  const bloco = celula ? celula.closest("table") : blocoAtual();
  if (!bloco) editorAtivo.append(tabela, depois);
  else if (bloco.nodeType === 1 && bloco.tagName === "P" && !bloco.textContent.trim()) bloco.replaceWith(tabela, depois);
  else bloco.after(tabela, depois);
  colocarCursorEm(cab.firstChild);
}

// Conserta listas que o navegador põe dentro de <p> (HTML inválido).
function consertarListas() {
  if (!editorAtivo) return;
  const ruins = editorAtivo.querySelectorAll("p > ul, p > ol");
  if (!ruins.length) return;
  const s = sel();
  const pos = s.rangeCount ? [s.anchorNode, s.anchorOffset] : null;
  for (const lista of ruins) {
    const p = lista.parentElement;
    if (p?.tagName === "P") p.replaceWith(...[...p.childNodes].filter((n) => n.nodeType === 1 || n.textContent.trim()));
  }
  if (pos && editorAtivo.contains(pos[0])) {
    const r = document.createRange();
    r.setStart(pos[0], Math.min(pos[1], pos[0].nodeType === 3 ? pos[0].length : pos[0].childNodes.length));
    s.removeAllRanges();
    s.addRange(r);
  }
}

function maisLinhaAcima(c) {
  const tr = c.parentElement;
  const tabela = tr.closest("table");
  const cabecalho = tr.parentElement.tagName === "THEAD";
  const nova = document.createElement("tr");
  for (let i = 0; i < colunasDe(tabela); i++) nova.appendChild(celulaVazia(cabecalho ? "th" : "td"));
  tr.before(nova);
  colocarCursorEm(nova.firstChild);
}

function maisColunaEsquerda(c) {
  const k = [...c.parentElement.children].indexOf(c);
  c.closest("table").querySelectorAll("tr").forEach((tr) => {
    const ref = tr.children[Math.min(k, tr.children.length - 1)];
    const nova = celulaVazia(tr.parentElement.tagName === "THEAD" ? "th" : "td");
    if (ref) ref.before(nova); else tr.appendChild(nova);
  });
}

function maisLinha(c) {
  const tr = c.parentElement;
  const tabela = tr.closest("table");
  const nova = linhaNova(colunasDe(tabela));
  if (tr.parentElement.tagName === "THEAD") {
    let tbody = tabela.querySelector("tbody");
    if (!tbody) tabela.appendChild((tbody = document.createElement("tbody")));
    tbody.prepend(nova);
  } else tr.after(nova);
  colocarCursorEm(nova.firstChild);
}

function maisColuna(c) {
  const k = [...c.parentElement.children].indexOf(c);
  c.closest("table").querySelectorAll("tr").forEach((tr) => {
    const ref = tr.children[Math.min(k, tr.children.length - 1)];
    const nova = celulaVazia(tr.parentElement.tagName === "THEAD" ? "th" : "td");
    if (ref) ref.after(nova); else tr.appendChild(nova);
  });
}

function menosLinha(c) {
  const tr = c.parentElement;
  const tabela = tr.closest("table");
  if (tabela.querySelectorAll("tr").length === 1) return tabela.remove();
  tr.remove();
  tabela.querySelectorAll("thead:empty, tbody:empty").forEach((x) => x.remove());
}

function menosColuna(c) {
  const tabela = c.closest("table");
  if (colunasDe(tabela) === 1) return tabela.remove();
  const k = [...c.parentElement.children].indexOf(c);
  tabela.querySelectorAll("tr").forEach((tr) => tr.children[k]?.remove());
}

// ---------------------------------------------------------------------------
// Barra de formatação
// ---------------------------------------------------------------------------

const BOTOES = [
  { id: "bold", rotulo: "<b>N</b>", titulo: "Negrito (Ctrl+B)", acao: () => cmd("bold"), estado: "bold" },
  { id: "italic", rotulo: "<i>I</i>", titulo: "Itálico (Ctrl+I)", acao: () => cmd("italic"), estado: "italic" },
  { id: "underline", rotulo: "<u>S</u>", titulo: "Sublinhado (Ctrl+U)", acao: () => cmd("underline"), estado: "underline" },
  "|",
  { id: "subtitulo", rotulo: "Subtítulo", titulo: "Transforma a linha em subtítulo (clique de novo para voltar a texto)", acao: alternarSubtitulo },
  { id: "pequeno", rotulo: "<small>Texto pequeno</small>", titulo: "Letra menor (para notas, legendas, observações)", acao: alternarPequeno },
  { id: "sub", rotulo: "X<sub>2</sub>", titulo: "Subscrito (ex.: H₂O)", acao: () => cmd("subscript"), estado: "subscript" },
  { id: "sup", rotulo: "X<sup>2</sup>", titulo: "Sobrescrito (ex.: cm²)", acao: () => cmd("superscript"), estado: "superscript" },
  "|",
  { id: "lista", rotulo: "• Lista", titulo: "Lista com marcadores", acao: () => cmd("insertUnorderedList"), estado: "insertUnorderedList" },
  { id: "numerada", rotulo: "1. Lista", titulo: "Lista numerada", acao: () => cmd("insertOrderedList"), estado: "insertOrderedList" },
  { id: "passos", rotulo: "☑ Passos", titulo: "Lista de passos com caixinha para marcar (ótimo para protocolos)", acao: alternarPassos },
  "|",
  { menu: "Tabela", titulo: "Inserir ou mudar uma tabela", itens: [
    { rotulo: "Nova tabela", acao: novaTabela },
    { rotulo: "+ Linha acima", naTabela: maisLinhaAcima },
    { rotulo: "+ Linha abaixo", naTabela: maisLinha },
    { rotulo: "+ Coluna à esquerda", naTabela: maisColunaEsquerda },
    { rotulo: "+ Coluna à direita", naTabela: maisColuna },
    { rotulo: "− Remover linha", naTabela: menosLinha },
    { rotulo: "− Remover coluna", naTabela: menosColuna },
    { rotulo: "Remover tabela", naTabela: (c) => c.closest("table").remove(), perigo: true },
  ] },
  "|",
  { id: "nota", rotulo: "✱ Nota", titulo: "Nota na margem para as palavras selecionadas (ex.: *, 2x, “repetido”). Com o cursor numa nota: editar ou apagar", acao: alternarNota },
  { id: "caixa", rotulo: "▭ Caixa", titulo: "Põe as linhas selecionadas dentro de um bloco com bordas (ótimo para comentários). Clique de novo para tirar", acao: alternarCaixa },
  "|",
  { menu: "Alinhamento", titulo: "Alinhar a linha (ou as linhas selecionadas)", itens: [
    { rotulo: "À esquerda", acao: () => cmd("justifyLeft") },
    { rotulo: "Centralizado", acao: () => cmd("justifyCenter") },
    { rotulo: "À direita", acao: () => cmd("justifyRight") },
    { rotulo: "Justificado", acao: () => cmd("justifyFull") },
  ] },
  { id: "limpar", rotulo: "Limpar formatação", titulo: "Tira negrito, itálico, tamanho etc. do trecho selecionado", acao: () => { cmd("removeFormat"); } },
];

let barraAtual = null;

function executar(fn) {
  if (!garantirCursor()) return;
  fn();
  avisarMudanca();
}

export function montarBarra(container) {
  container.className = "barra-formatacao";
  container.innerHTML = "";
  const fecharMenus = () => container.querySelectorAll(".menu-barra").forEach((m) => { m.hidden = true; });
  for (const b of BOTOES) {
    if (b === "|") {
      container.insertAdjacentHTML("beforeend", '<span class="separador"></span>');
      continue;
    }
    if (b.menu) {
      const caixa = document.createElement("div");
      caixa.className = "menu-caixa";
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "bf";
      botao.title = b.titulo;
      botao.textContent = `${b.menu} ▾`;
      const menu = document.createElement("div");
      menu.className = "menu-barra";
      menu.hidden = true;
      for (const item of b.itens) {
        const it = document.createElement("button");
        it.type = "button";
        it.className = `menu-item${item.perigo ? " perigo" : ""}${item.naTabela ? " so-tabela" : ""}`;
        it.textContent = item.rotulo;
        it.addEventListener("mousedown", (e) => e.preventDefault());
        it.addEventListener("click", () => {
          fecharMenus();
          executar(() => {
            if (item.naTabela) {
              const c = celulaDoCursor();
              if (c) item.naTabela(c);
            } else item.acao();
          });
        });
        menu.appendChild(it);
      }
      botao.addEventListener("mousedown", (e) => e.preventDefault());
      botao.addEventListener("click", () => {
        const abrir = menu.hidden;
        fecharMenus();
        if (!abrir) return;
        garantirCursor();
        const naTabela = !!celulaDoCursor();
        menu.querySelectorAll(".so-tabela").forEach((x) => { x.disabled = !naTabela; });
        menu.hidden = false;
      });
      caixa.append(botao, menu);
      container.appendChild(caixa);
      continue;
    }
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "bf";
    botao.dataset.id = b.id;
    if (b.estado) botao.dataset.estado = b.estado;
    botao.title = b.titulo;
    botao.innerHTML = b.rotulo;
    botao.addEventListener("mousedown", (e) => e.preventDefault());
    botao.addEventListener("click", () => { fecharMenus(); executar(b.acao); });
    container.appendChild(botao);
  }
  document.addEventListener("mousedown", (e) => { if (!container.contains(e.target)) fecharMenus(); });
  barraAtual = container;
}

function atualizarEstadoDaBarra() {
  if (!barraAtual || !document.body.contains(barraAtual)) return;
  const s = sel();
  const dentro = s.rangeCount && editorAtivo?.contains(s.anchorNode);
  barraAtual.querySelectorAll("[data-estado]").forEach((b) => {
    let ativo = false;
    try { ativo = dentro && document.queryCommandState(b.dataset.estado); } catch {}
    b.classList.toggle("ativo", !!ativo);
  });
  const el = dentro ? elementoDe(s.anchorNode) : null;
  barraAtual.querySelector('[data-id="subtitulo"]')?.classList.toggle("ativo", !!el?.closest("h3"));
  barraAtual.querySelector('[data-id="pequeno"]')?.classList.toggle("ativo", !!el?.closest("small"));
  barraAtual.querySelector('[data-id="passos"]')?.classList.toggle("ativo", !!el?.closest("ul.tarefas"));
  barraAtual.querySelector('[data-id="nota"]')?.classList.toggle("ativo", !!el?.closest("span.nota"));
  barraAtual.querySelector('[data-id="caixa"]')?.classList.toggle("ativo", !!el?.closest("blockquote.caixa"));
}
