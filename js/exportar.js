// Exportar um texto (ou um diário inteiro) como PDF, Word (.docx) ou .txt.

import { esc, dataLonga, nomeDeArquivo, baixarArquivo, agora, datasDoTexto } from "./util.js";
import { gruposDeNotas, desenharNotas } from "./editor.js";

// Nota que cobre várias linhas: nas exportações em texto (.txt e Word), o
// texto da nota vai uma vez só, depois do último pedaço.
function marcarFimDasNotas(raiz) {
  for (const partes of gruposDeNotas(raiz)) partes[partes.length - 1].dataset.fimNota = "1";
}

// Monta o documento: título + corpo; no diário, a descrição e as entradas
// (fora da lixeira) em ordem cronológica, cada uma com data e hora.
function montar(texto) {
  let html = texto.corpo || "";
  if (texto.tipo === "diario") {
    const entradas = (texto.entradas || [])
      .filter((e) => !e.naLixeira)
      .sort((a, b) => `${a.data} ${a.hora}`.localeCompare(`${b.data} ${b.hora}`));
    html += entradas.map((e, i) =>
      `<h2 class="entrada">Entrada nº ${i + 1} — ${esc(dataLonga(e.data))}, ${esc(e.hora)}</h2>${e.corpo || "<p></p>"}`).join("");
  }
  return { titulo: texto.titulo || "Sem título", html, datas: datasDoTexto(texto) };
}

const CSS_IMPRESSAO = `
  @page { size: A4; margin: 2.5cm 2cm; }
  body { font: 12pt/1.5 "Times New Roman", Times, serif; color: #000; margin: 0; }
  h1 { font-size: 18pt; margin: 0 0 1em; }
  h2 { font-size: 14pt; margin: 1.4em 0 .5em; }
  h2.entrada { border-bottom: 1px solid #999; padding-bottom: .2em; }
  h3 { font-size: 12.5pt; margin: 1.2em 0 .4em; }
  p { margin: 0 0 .6em; }
  small { font-size: 9.5pt; }
  table { border-collapse: collapse; margin: .6em 0 1em; width: 100%; }
  th, td { border: 1px solid #000; padding: 3pt 6pt; text-align: left; vertical-align: top; }
  th { background: #eee; }
  ul.tarefas { list-style: none; padding-left: 1.2em; }
  ul.tarefas li::before { content: "☐  "; }
  ul.tarefas li[data-feito="true"]::before { content: "☑  "; }
  .rodape { margin-top: 2em; font-size: 9pt; color: #555; }
  .datas { margin: -.6em 0 1.4em; font-size: 10pt; color: #333; line-height: 1.45; }
  blockquote { margin: .8em 0; padding: .1em 1em; border-left: 2px solid #999; }
  blockquote.caixa { border: 1px solid #555; border-radius: 4pt; padding: .5em .8em; background: #f4f4f4; }
  blockquote.caixa > :last-child { margin-bottom: 0; }
  .rt-moldura { position: relative; }
  .rt.com-notas { margin-right: 3cm; }
  span.nota { text-decoration: underline dotted; }
  .rt-notas { position: absolute; top: 0; right: 0; bottom: 0; width: 2.6cm; }
  .nota-barra { position: absolute; left: 0; width: 1.5pt; background: #555; }
  .nota-texto { position: absolute; left: .2cm; right: 0; font: bold 8.5pt/1.3 sans-serif; color: #333; }
`;

// PDF: abre a janela de impressão só com o documento ("Salvar como PDF").
// O texto do PDF fica selecionável e pesquisável.
export function exportarPdf(texto) {
  const { titulo, html, datas } = montar(texto);
  const iframe = document.createElement("iframe");
  // Mesma largura da área útil da folha A4, para as notas da margem ficarem
  // na altura certa (fora da tela).
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:170mm;height:1200px;border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(nomeDeArquivo(titulo))}</title><style>${CSS_IMPRESSAO}</style></head>
    <body><h1>${esc(titulo)}</h1><p class="datas">${datas.map(([r, v]) => `<strong>${esc(r)}:</strong> ${esc(v)}`).join("<br>")}</p><div class="rt-moldura"><div class="rt">${html}</div><div class="rt-notas"></div></div><p class="rodape">Exportado em ${esc(new Date().toLocaleString("pt-BR"))}</p></body></html>`);
  doc.close();
  setTimeout(() => {
    desenharNotas(doc.querySelector(".rt"), doc.querySelector(".rt-notas"));
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 60000);
  }, 150);
}

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------

function paraTexto(no) {
  if (no.nodeType === 3) return no.textContent.replace(/\s+/g, " ");
  if (no.nodeType !== 1) return "";
  const tag = no.tagName;
  const dentro = () => [...no.childNodes].map(paraTexto).join("");
  switch (tag) {
    case "BR": return "\n";
    case "SPAN": return no.dataset.fimNota ? `${dentro()} [${no.dataset.nota}]` : dentro();
    case "BLOCKQUOTE":
      if (no.classList.contains("caixa")) {
        const linhas = dentro().trim().replace(/\n{3,}/g, "\n\n").split("\n");
        return `\n┌${"─".repeat(40)}\n${linhas.map((l) => `│ ${l}`).join("\n")}\n└${"─".repeat(40)}\n`;
      }
      return `\n${dentro().trim()}\n`;
    case "P": case "DIV": return `\n${dentro().trim()}\n`;
    case "H2": case "H3": {
      const t = dentro().trim();
      return `\n\n${t}\n${(tag === "H2" ? "=" : "-").repeat(Math.min(t.length, 60))}\n`;
    }
    case "HR": return "\n----------\n";
    case "UL": case "OL": {
      const tarefas = no.classList.contains("tarefas");
      return "\n" + [...no.children].map((li, i) => {
        const marca = tarefas ? (li.dataset.feito === "true" ? "[x] " : "[ ] ") : tag === "OL" ? `${i + 1}. ` : "- ";
        return marca + paraTexto(li).trim().replace(/\n+/g, "\n   ");
      }).join("\n") + "\n";
    }
    case "TABLE":
      return "\n" + [...no.querySelectorAll("tr")].map((tr) => "| " + [...tr.children].map((c) => paraTexto(c).replace(/\s+/g, " ").trim()).join(" | ") + " |").join("\n") + "\n";
    default: return dentro();
  }
}

export function exportarTxt(texto) {
  const { titulo, html, datas } = montar(texto);
  const div = document.createElement("div");
  div.innerHTML = html;
  marcarFimDasNotas(div);
  const corpo = paraTexto(div).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const cabecalho = datas.map(([r, v]) => `${r}: ${v}`).join("\n");
  const conteudo = `${titulo}\n${"=".repeat(Math.min(titulo.length, 60))}\n${cabecalho}\n\n${corpo}\n`;
  baixarArquivo(`${nomeDeArquivo(titulo)}.txt`, conteudo, "text/plain;charset=utf-8");
}

// ---------------------------------------------------------------------------
// DOCX (biblioteca "docx", carregada só quando necessário)
// ---------------------------------------------------------------------------

function carregarDocx() {
  if (window.docx) return Promise.resolve(window.docx);
  return new Promise((ok, erro) => {
    const s = document.createElement("script");
    s.src = "vendor/docx.umd.js";
    s.onload = () => ok(window.docx);
    s.onerror = () => erro(new Error("Não consegui carregar o gerador de .docx (sem internet?)."));
    document.head.appendChild(s);
  });
}

export async function exportarDocx(texto) {
  const D = await carregarDocx();
  const { titulo, html, datas } = montar(texto);
  const div = document.createElement("div");
  div.innerHTML = html;
  marcarFimDasNotas(div);
  let listasNumeradas = 0;

  const alinhamento = (el) => ({
    center: D.AlignmentType.CENTER, right: D.AlignmentType.RIGHT, justify: D.AlignmentType.JUSTIFIED,
  }[el?.style?.textAlign] || undefined);

  function runs(no, f = {}) {
    if (no.nodeType === 3) {
      const t = no.textContent.replace(/\s+/g, " ");
      if (!t) return [];
      return [new D.TextRun({
        text: t, bold: f.b, italics: f.i, underline: f.u ? {} : undefined,
        size: f.pequeno ? 19 : undefined, superScript: f.sup, subScript: f.sub,
      })];
    }
    if (no.nodeType !== 1) return [];
    const tag = no.tagName;
    if (tag === "BR") return [new D.TextRun({ text: "", break: 1 })];
    if (tag === "UL" || tag === "OL" || tag === "TABLE") return [];
    const g = { ...f };
    if (tag === "STRONG" || tag === "B" || tag === "TH") g.b = true;
    if (tag === "EM" || tag === "I") g.i = true;
    if (tag === "U") g.u = true;
    if (tag === "SMALL") g.pequeno = true;
    if (tag === "SUP") g.sup = true;
    if (tag === "SUB") g.sub = true;
    const filhos = [...no.childNodes].flatMap((c) => runs(c, g));
    if (tag === "SPAN" && no.dataset.fimNota) {
      filhos.push(new D.TextRun({ text: ` ${no.dataset.nota}`, bold: true, superScript: true, color: "444444" }));
    }
    return filhos;
  }

  // Parágrafo; dentro de uma caixa (comentário), ganha borda e fundo cinza.
  let naCaixa = false;
  const borda = { style: D.BorderStyle.SINGLE, size: 6, color: "555555", space: 6 };
  const par = (o) => { const opcoes = typeof o === "string" ? { text: o } : o; return new D.Paragraph(naCaixa
    ? { ...opcoes, border: { top: borda, bottom: borda, left: borda, right: borda }, shading: { type: D.ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } }
    : opcoes); };

  function lista(ul, nivel) {
    const tarefas = ul.classList.contains("tarefas");
    const numerada = ul.tagName === "OL";
    const instancia = numerada ? ++listasNumeradas : 0;
    const saida = [];
    for (const li of ul.children) {
      const filhos = runs(li);
      if (tarefas) filhos.unshift(new D.TextRun(li.dataset.feito === "true" ? "☑  " : "☐  "));
      saida.push(par({
        children: filhos,
        alignment: alinhamento(li),
        ...(tarefas ? { indent: { left: 360 + nivel * 360 } }
          : numerada ? { numbering: { reference: "numerada", level: Math.min(nivel, 2), instance: instancia } }
          : { bullet: { level: Math.min(nivel, 2) } }),
      }));
      for (const sub of li.querySelectorAll(":scope > ul, :scope > ol")) saida.push(...lista(sub, nivel + 1));
    }
    return saida;
  }

  function tabela(t) {
    const linhas = [...t.querySelectorAll("tr")].map((tr) => new D.TableRow({
      children: [...tr.children].map((c) => new D.TableCell({
        children: [new D.Paragraph({ children: runs(c), alignment: alinhamento(c) })],
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
      })),
    }));
    return [new D.Table({ rows: linhas, width: { size: 100, type: D.WidthType.PERCENTAGE } }), par("")];
  }

  function blocos(no) {
    if (no.nodeType === 3) return no.textContent.trim() ? [par({ children: runs(no) })] : [];
    if (no.nodeType !== 1) return [];
    switch (no.tagName) {
      case "H2": return [par({ children: runs(no), heading: D.HeadingLevel.HEADING_2, alignment: alinhamento(no) })];
      case "H3": return [par({ children: runs(no), heading: D.HeadingLevel.HEADING_3, alignment: alinhamento(no) })];
      case "UL": case "OL": return lista(no, 0);
      case "TABLE": return tabela(no);
      case "HR": return [par("")];
      case "BLOCKQUOTE":
        if (no.classList.contains("caixa")) {
          // Parágrafos seguidos com a mesma borda: o Word desenha uma caixa só.
          const antes = naCaixa;
          naCaixa = true;
          try {
            return no.querySelector("p, h2, h3, ul, ol, table, div") ? [...no.childNodes].flatMap(blocos) : [par({ children: runs(no) })];
          } finally { naCaixa = antes; }
        }
        // fallthrough
      case "DIV": case "SECTION":
        if (no.querySelector("p, h2, h3, ul, ol, table, div")) return [...no.childNodes].flatMap(blocos);
        return [par({ children: runs(no), alignment: alinhamento(no) })];
      default: return [par({ children: runs(no), alignment: alinhamento(no) })];
    }
  }

  const fonte = "Times New Roman";
  const doc = new D.Document({
    creator: "Caderno",
    title: titulo,
    styles: {
      default: {
        document: { run: { font: fonte, size: 24 }, paragraph: { spacing: { after: 120, line: 300 } } },
        title: { run: { font: fonte, size: 36, bold: true, color: "000000" } },
        heading2: { run: { font: fonte, size: 28, bold: true, color: "000000" }, paragraph: { spacing: { before: 280, after: 120 } } },
        heading3: { run: { font: fonte, size: 25, bold: true, color: "000000" }, paragraph: { spacing: { before: 200, after: 100 } } },
      },
    },
    numbering: {
      config: [{
        reference: "numerada",
        levels: [0, 1, 2].map((n) => ({
          level: n, format: D.LevelFormat.DECIMAL, text: `%${n + 1}.`, alignment: D.AlignmentType.START,
          style: { paragraph: { indent: { left: 720 + n * 360, hanging: 360 } } },
        })),
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1418, bottom: 1418, left: 1134, right: 1134 } } },
      children: [
        new D.Paragraph({ text: titulo, heading: D.HeadingLevel.TITLE }),
        ...datas.map(([r, v], i) => new D.Paragraph({
          children: [new D.TextRun({ text: `${r}: `, bold: true, size: 20 }), new D.TextRun({ text: v, size: 20 })],
          spacing: { after: i === datas.length - 1 ? 280 : 0 },
        })),
        ...[...div.childNodes].flatMap(blocos),
      ],
    }],
  });
  const blob = await D.Packer.toBlob(doc);
  baixarArquivo(`${nomeDeArquivo(titulo)}.docx`, blob);
}

export const _paraTeste = { montar, agora };
