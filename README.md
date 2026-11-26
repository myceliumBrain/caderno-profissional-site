# Caderno — agenda pessoal criptografada

Site estático (HTML + CSS + JavaScript, sem build) para guardar textos em
cadernos temáticos: protocolos do laboratório, revisão de literatura, etc.
Funciona como o painel do astrobotanica: o repositório é fixo em
`js/config.js` (`myceliumBrain/caderno-profissional-site`), o primeiro acesso
pede só o **token do GitHub e uma senha**, e depois disso o site pede só a
senha. Dois arquivos:

- `data/auth.json`: o token do GitHub, criptografado.
- `data/caderno.json`: cadernos e textos, **criptografados** com a mesma chave.
- `data/arquivos/`: arquivos anexados (PDFs, fotos…), também criptografados.

O repositório e o site podem ser públicos: sem a senha (ou o código de
recuperação), os arquivos são ilegíveis.

## Como funciona

- **Cadernos** em cartões grandes na tela inicial (“Meus cadernos”); dentro deles, dois tipos de texto:
  - **Texto pontual**: um documento único (ex.: um protocolo), com **dia de execução**
    (quando foi feito de fato, ex.: escrito à mão e passado para o caderno dias
    depois) além de criado e editado. As três datas vão no modo Ler e nas
    exportações (PDF, Word, .txt).
  - **Texto contínuo**: um “Sobre” opcional + **entradas com data e hora**,
    numeradas. Cada entrada é uma página (setinhas ‹ › ou a lista para pular);
    nas exportações, tudo continua em texto corrido. Na lista do caderno
    aparecem o “Sobre” e as datas da primeira e da última entrada. Feito para
    a revisão de literatura em que você avança um pouco por dia.
  - Na lista do caderno, cada texto tem **Ler** e **Escrever** (clicar no
    cartão abre em Ler).
- **Editor visual** (Escrever / Ler) com barra de formatação: negrito, itálico,
  sublinhado, subtítulo, texto pequeno, sub/sobrescrito, listas, lista de
  **passos** com caixinha (marcável também no modo Ler, útil na bancada),
  tabelas (com linha acima/abaixo e coluna à esquerda/direita), **notas na margem** (✱ Nota: um “*” ou “2x” ao lado das palavras selecionadas), **caixa com bordas** para comentários (▭ Caixa), **links** (🔗 Link: selecione o texto ou só clique para inserir; no modo Ler o clique abre o site, no Escrever é Ctrl+clique), **arquivos no meio do texto** (📎 Arquivo: o PDF de um artigo, uma foto… entram onde está o cursor, como uma etiqueta que abre com um clique; até 25 MB cada), alinhamento e limpar formatação. Textos em Times New Roman; a
  interface em Lexend. Tema claro ou escuro (⚙ → Aparência). Ao colar de Word/PDF/sites, a formatação estranha é limpa.
- **Painéis laterais recolhíveis**: cadernos e lista de textos (esta começa recolhida).
- **Lembretes** na página inicial, ao lado dos cadernos. O **+** oferece
  *Criar pasta* ou *Criar lembrete*: pastas (ex.: “Laboratório”, “Casa”) abrem
  dentro do próprio quadro e guardam seus lembretes. Cada lembrete tem
  **título, descrição, cor** (🔴 Prioritário, 🔵 Intelectual, 🟢 Rotina,
  🟡 Social), **previsão de conclusão**, **data limite**, **fontes** (links de
  sites/artigos, com nome opcional, separados da descrição) e **anexos** (fotos,
  PDFs, qualquer arquivo até 25 MB, em `data/arquivos/`). O ✎ edita
  tudo isso. Marcar como feito leva para “Concluídos”; só ali dá para excluir
  de vez, e aí os anexos também são apagados do repositório (o mesmo vale ao
  excluir uma pasta) — veja “Arquivos anexados” abaixo.
  - No topo do site aparece **“X lembretes”** (os pendentes).
  - No rodapé aparecem os pendentes perto do prazo: **!** a 4 dias da previsão
    e **!!** a 7 dias da data limite (ou atrasados). Clicar leva ao lembrete.
  - Abaixo dos lembretes há um **calendário** do mês, como uma agenda: cada
    lembrete aparece no dia da previsão (fundo claro) e no da data limite (cor
    cheia). Clicar num dia lista o que está marcado nele.
- **Lixeira**: cadernos, textos e entradas vão para a Lixeira (depois de “Novo
  caderno”). Lá, a setinha ▾ de cada item permite **Restaurar** ou **Apagar
  definitivamente** (sempre com um aviso de confirmação; apagar um caderno
  apaga também os textos dentro dele).
- **Backup automático**: a cada salvamento, o GitHub Action
  `.github/workflows/backup.yml` copia a pasta `data/` (criptografada) para o
  repositório privado `myceliumBrain/caderno-profissional-backup`, que guarda o
  histórico de versões. O acesso é uma *deploy key* que só grava nesse
  repositório (segredo `BACKUP_DEPLOY_KEY`). Como restaurar: veja o README de lá.
- **Exportar** cada texto (o texto contínuo inteiro, com as entradas) em PDF, Word
  (.docx) e .txt.
- **Nada se perde**: cada alteração é copiada em segundos para o navegador
  (cifrada com a sua chave). Se a aba fechar ou a internet cair, ao entrar de
  novo o site recupera essas alterações, envia ao GitHub e reabre o texto onde
  você estava. Sem internet, ele tenta reenviar sozinho.
- **Busca** em todos os textos e entradas (ignora acentos).
- **Salvamento**: automático 15 s depois da última alteração, ou na hora com
  o botão Salvar ou `Ctrl+S`. No modo GitHub, cada salvamento é um commit.
- **Dois aparelhos ao mesmo tempo**: se o arquivo mudou em outro lugar, o site
  junta as versões (por texto, vale a edição mais recente).

## Segurança e recuperação

- Uma chave mestra aleatória cifra o token e os textos (AES-GCM 256). Essa
  chave fica guardada duas vezes em `data/auth.json`: uma trancada pela **senha** e outra pelo
  **código de recuperação** (PBKDF2-SHA256, 600.000 iterações).
- O **código de recuperação** aparece uma única vez, na criação. Guarde-o fora
  do computador. Em “Esqueci a senha”, ele permite definir uma senha nova.
  Em Configurações dá para gerar outro código (o antigo deixa de valer).
- **Sem a senha e sem o código, não há como recuperar o conteúdo.** Nem eu,
  nem o GitHub conseguimos.
- O conteúdo cifrado é público, então use uma senha longa (uma frase).
- **Backup**: Configurações → Exportar backup gera um `.json` legível (sem o
  token). Guarde-o com cuidado, porque ele não é criptografado. “Importar
  backup” junta um backup ao caderno.
- O histórico do git guarda todas as versões do caderno, todas cifradas com
  a mesma chave mestra.

## Publicar e usar

1. Crie o repositório `caderno-profissional-site` no GitHub (usuário
   `myceliumBrain`) e envie estes arquivos:
   ```bash
   git add . && git commit -m "Caderno"
   git remote add origin git@github.com:myceliumBrain/caderno-profissional-site.git
   git push -u origin main
   ```
2. No repositório: Settings → Pages → Deploy from a branch → `main` / root.
3. Crie um token fine-grained em
   <https://github.com/settings/personal-access-tokens/new> com acesso
   **só a esse repositório** e permissão **Contents: Read and write**.
4. Abra o site, cole o token e escolha a senha. O site faz o commit de
   `data/auth.json` e `data/caderno.json` sozinho. Anote o código de
   recuperação.

Localmente, com `python3 serve.py` (http://localhost:8000), funciona igual:
lê e grava direto no GitHub, então não é preciso `git pull` para ver os
textos. Rode `git pull` antes de mexer nos arquivos locais, para não
sobrescrever o que o site gravou.

Os tokens fine-grained expiram. Quando isso acontecer, o status mostra o erro.
Gere um token novo e cole em ⚙ Configurações → Token do GitHub.

Para usar outro repositório, mude `js/config.js`.

## Estrutura

```
index.html            telas (criação, código, login, recuperação, app)
css/style.css         visual (tema claro ou escuro, Lexend + Times New Roman, celular)
js/config.js          repositório (dono, nome, branch, caminhos)
js/app.js             interface: telas de acesso, cadernos, lixeira, textos contínuos, lembretes, configurações
js/editor.js          editor visual e barra de formatação
js/exportar.js        exportar em PDF, DOCX e TXT
js/rascunho.js        cópia local cifrada e posição onde você parou
js/util.js            funções pequenas (datas, textos, download)
js/cripto.js          criptografia (senha, código de recuperação, conteúdo)
js/armazenamento.js   leitura/gravação pela API do GitHub
js/mesclar.js         junta versões vindas de aparelhos diferentes
js/arquivos.js        arquivos anexados: nome pelo conteúdo e coleta de lixo
vendor/               DOMPurify (sanitização), docx (gerar .docx), marked (converte textos antigos em Markdown)
serve.py              servidor local
data/auth.json        token do GitHub, cifrado (criado no primeiro acesso)
data/caderno.json     cadernos e textos, cifrados (criado no primeiro acesso)
data/arquivos/        arquivos anexados (textos e lembretes), cifrados
```

### Arquivos anexados

Mesma arquitetura que o próprio Git usa para guardar seus objetos:
**armazenamento endereçado por conteúdo + coleta de lixo “marcar e varrer”**.

- Cada arquivo vai para `data/arquivos/<nome>.bin`, onde o nome é tirado do
  **conteúdo** (HMAC-SHA256 com uma chave derivada da chave do caderno; um
  SHA-256 puro revelaria qual é o arquivo). O mesmo PDF anexado em dois
  textos, ou duas vezes, gera o mesmo nome e é gravado **uma vez só**: não há
  como duplicar nem dois arquivos disputarem um nome.
- O caderno não mantém contadores de uso (que podem se desencontrar). Um
  arquivo está em uso se algum texto, entrada, lembrete — inclusive na
  lixeira — o cita.
- Depois de salvar (no máximo 1 vez por hora), o site lista `data/arquivos/` e
  **marca** os que nada cita. Um arquivo só é **apagado** se continuar sem uso
  numa coleta feita 24 h depois (como o prazo do `git gc`). Isso protege um
  envio em andamento em outro aparelho e o “desfazer” logo depois de tirar um
  anexo do texto.
- Anexos de lembretes do formato antigo (`data/anexos/`) são copiados para
  `data/arquivos/` na primeira abertura; a cópia antiga é apagada pela coleta.
- O histórico do Git guarda versões antigas para sempre; a coleta tira o
  arquivo da versão atual do repositório (e do backup).

### Formato de `data/caderno.json` (depois de decifrado)

```json
{
  "pastas": [{ "id": "pasta-…", "nome": "Protocolos do laboratório", "criadoEm": "…", "atualizadoEm": "…" }],
  "textos": [{
    "id": "texto-…", "pastaId": "pasta-…", "tipo": "texto | diario",
    "formato": "html", "titulo": "Extração de DNA", "corpo": "<h3>Passos</h3><ul class=\"tarefas\">…",
    "entradas": [{ "id": "entrada-…", "data": "2026-11-25", "hora": "14:32", "corpo": "<p>…</p>",
                   "naLixeira": null, "criadoEm": "…", "atualizadoEm": "…" }],
    "naLixeira": "data em que foi para a lixeira (ou ausente)",
    "criadoEm": "…", "atualizadoEm": "…"
  }],
  "removidos": { "texto-…": "data da exclusão" }
}
```
