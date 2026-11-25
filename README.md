# Caderno — agenda pessoal criptografada

Site estático (HTML + CSS + JavaScript, sem build) para guardar textos em
pastas temáticas: protocolos do laboratório, revisão de literatura, etc.
Funciona como o painel do astrobotanica: o repositório é fixo em
`js/config.js` (`myceliumBrain/caderno-profissional-site`), o primeiro acesso
pede só o **token do GitHub e uma senha**, e depois disso o site pede só a
senha. Dois arquivos:

- `data/auth.json`: o token do GitHub, criptografado.
- `data/caderno.json`: pastas e textos, **criptografados** com a mesma chave.

O repositório e o site podem ser públicos: sem a senha (ou o código de
recuperação), os arquivos são ilegíveis.

## Como funciona

- **Pastas** em cartões grandes na tela inicial; dentro delas, dois tipos de texto:
  - **Texto**: um documento único (ex.: um protocolo).
  - **Diário**: uma descrição opcional + **entradas com data e hora**, numeradas,
    numa linha do tempo (a mais recente no topo). Feito para a revisão de
    literatura em que você avança um pouco por dia.
- **Editor visual** (Escrever / Ler) com barra de formatação: negrito, itálico,
  sublinhado, subtítulo, texto pequeno, sub/sobrescrito, listas, lista de
  **passos** com caixinha (marcável também no modo Ler, útil na bancada),
  tabelas, alinhamento e limpar formatação. Textos em Times New Roman; a
  interface em Lexend. Tema claro ou escuro (⚙ → Aparência). Ao colar de Word/PDF/sites, a formatação estranha é limpa.
- **Painéis laterais recolhíveis**: pastas e lista de textos (esta começa recolhida).
- **Lembretes** na página inicial, ao lado das pastas: coisas pontuais para
  hoje ou amanhã. Marcar como feito leva para “Concluídos”; só ali dá para
  excluir de vez (os lembretes são a única coisa que o caderno apaga).
- **Lixeira**: nada é apagado. Pastas, textos e entradas vão para a Lixeira
  (depois de “Nova pasta”) e podem ser restaurados a qualquer momento.
- **Exportar** cada texto (o diário inteiro, com as entradas) em PDF, Word
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
js/app.js             interface: telas de acesso, pastas, lixeira, diário, configurações
js/editor.js          editor visual e barra de formatação
js/exportar.js        exportar em PDF, DOCX e TXT
js/rascunho.js        cópia local cifrada e posição onde você parou
js/util.js            funções pequenas (datas, textos, download)
js/cripto.js          criptografia (senha, código de recuperação, conteúdo)
js/armazenamento.js   leitura/gravação pela API do GitHub
js/mesclar.js         junta versões vindas de aparelhos diferentes
vendor/               DOMPurify (sanitização), docx (gerar .docx), marked (converte textos antigos em Markdown)
serve.py              servidor local
data/auth.json        token do GitHub, cifrado (criado no primeiro acesso)
data/caderno.json     pastas e textos, cifrados (criado no primeiro acesso)
```

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
