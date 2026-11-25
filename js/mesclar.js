// Junta duas versões do caderno (ex.: editou no celular e no computador).
// Regra: por item (pasta/texto/lembrete), vence a versão com "atualizadoEm" mais recente;
// itens excluídos ficam registrados em "removidos" para não "ressuscitarem".

function mesclarListas(locais, remotos, removidos) {
  const mapa = new Map();
  for (const x of locais) mapa.set(x.id, x);
  for (const x of remotos) {
    const atual = mapa.get(x.id);
    if (!atual || (x.atualizadoEm || "") > (atual.atualizadoEm || "")) mapa.set(x.id, x);
  }
  return [...mapa.values()].filter((x) => !(removidos[x.id] && removidos[x.id] >= (x.atualizadoEm || "")));
}

export function mesclarDados(local, remoto) {
  const removidos = { ...(remoto.removidos || {}) };
  for (const [id, quando] of Object.entries(local.removidos || {})) {
    if (!removidos[id] || quando > removidos[id]) removidos[id] = quando;
  }
  return {
    ...remoto,
    ...local,
    removidos,
    pastas: mesclarListas(local.pastas || [], remoto.pastas || [], removidos),
    textos: mesclarListas(local.textos || [], remoto.textos || [], removidos),
    lembretes: mesclarListas(local.lembretes || [], remoto.lembretes || [], removidos),
  };
}
