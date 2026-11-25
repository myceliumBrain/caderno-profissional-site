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

- **Pastas** na barra lateral; dentro delas, dois tipos de texto:
  - **Texto**: um documento em Markdown (ex.: um protocolo).
  - **Diário**: uma descrição opcional + **entradas datadas**. O botão
    “Entrada de hoje” abre (ou cria) a entrada do dia. É feito para a revisão
    de literatura em que você avança um pouco por dia.
- **Markdown** com pré-visualização (Escrever / Dividir / Ler). Checklists
  `- [ ] passo` podem ser marcados clicando na pré-visualização, o que é útil
  para seguir um protocolo na bancada.
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
css/style.css         visual (claro/escuro automático, celular)
js/config.js          repositório (dono, nome, branch, caminhos)
js/app.js             interface: telas de acesso, pastas, lista, editor, diário, configurações
js/cripto.js          criptografia (senha, código de recuperação, conteúdo)
js/armazenamento.js   leitura/gravação pela API do GitHub
js/mesclar.js         junta versões vindas de aparelhos diferentes
vendor/               marked (Markdown) e DOMPurify (sanitização)
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
    "titulo": "Extração de DNA", "corpo": "## Passos\n- [ ] …",
    "entradas": [{ "id": "entrada-…", "data": "2026-11-25", "corpo": "…", "criadoEm": "…", "atualizadoEm": "…" }],
    "criadoEm": "…", "atualizadoEm": "…"
  }],
  "removidos": { "texto-…": "data da exclusão" }
}
```
