# account-workflows

Framework de **workflows de cadastro** em TypeScript sobre o [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) (pacote npm `cloakbrowser`, API do Playwright). Cada workflow é uma lista declarativa de passos reutilizáveis (navegar, preencher formulário, enviar e capturar a resposta, extrair texto, asserções…), executada por um runner genérico que gera um relatório JSON por execução e salva screenshot em caso de falha.

O repositório inclui um formulário de cadastro local (`test-site/`) para desenvolver e testar workflows sem depender de sites externos.

## Requisitos

- Node.js 20+ (usa `fetch` nativo e ESM)
- ~200 MB livres para o binário do CloakBrowser

## Instalação

```bash
npm install
```

O binário do navegador (~200 MB) **não** vem no `npm install`: é baixado automaticamente no primeiro uso (primeira execução de um workflow ou do teste e2e).

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm run demo` | Sobe o formulário local numa porta livre e roda o workflow `local-signup` contra ele (headless). |
| `npm run serve` | Sobe só o formulário de teste em `http://127.0.0.1:3000` (porta via argumento ou `PORT`). |
| `npm run workflow -- list` | Lista os workflows registrados. |
| `npm run workflow -- run <nome> [opções]` | Executa um workflow. |
| `npm run typecheck` | `tsc` (sem emitir arquivos). |
| `npm test` | `vitest run` (o teste e2e só roda com `E2E=1`). |

Opções de `run`:

- `--serve` — sobe o formulário local numa porta livre e usa-o como `baseUrl`
- `--headed` — mostra a janela do navegador (padrão: headless)
- `--humanize` — mouse/teclado com ritmo humano (recurso nativo do CloakBrowser)
- `--slow-mo <ms>` — atraso entre ações, útil para depuração
- `--base-url <url>` — sobrescreve `defaults.baseUrl` do workflow
- `--set campo=valor` — sobrescreve campos do input (repetível; `true`/`false` viram booleanos)

Exemplo:

```bash
npm run workflow -- run local-signup --serve --headed --humanize --set country=PT --set newsletter=true
```

Cada execução grava `runs/<runId>.json` (senhas são substituídas por `[redacted]`) e, se falhar, `runs/<runId>.png`.

Teste ponta a ponta com navegador real:

```bash
E2E=1 npx vitest run tests/e2e.test.ts tests/recorder-e2e.test.ts   # bash
$env:E2E="1"; npx vitest run tests/e2e.test.ts   # PowerShell
```

## Arquitetura

```
 src/cli.ts ──► workflows/index.ts (registry) ──► workflows/<nome>.ts
     │                                               │ defineWorkflow({ steps: [...] })
     ▼                                               ▼
 core/runner.ts ──► core/browser.ts (CloakBrowser)   core/steps.ts (passos reutilizáveis)
     │                                               core/data.ts  (dados falsos)
     ▼
 runs/<runId>.json (+ .png em falha)

 test-site/server.ts + public/index.html  ← formulário local p/ testes
```

- `src/core/types.ts` — tipos (`WorkflowDefinition`, `Step`, `WorkflowContext`, `RunResult`…)
- `src/core/registry.ts` — `defineWorkflow()` (valida a definição) e `WorkflowRegistry`
- `src/core/runner.ts` — `runWorkflow()`: monta o contexto, executa os passos, gera relatório
- `src/core/browser.ts` — abre/fecha a sessão do CloakBrowser
- `src/core/steps.ts` — biblioteca de passos
- `src/core/data.ts` — `fakePerson()` para gerar dados de cadastro
- `tests/` — testes vitest (servidor, registry e e2e opcional)

## Como adicionar um novo workflow

1. Crie `src/workflows/meu-site.ts` exportando `defineWorkflow({...})` por padrão:

```ts
import { fakePerson } from "../core/data.js";
import { defineWorkflow } from "../core/registry.js";
import { fillForm, goto, submitAndCapture, waitVisible } from "../core/steps.js";

interface MeuSiteInput {
  email: string;
  password: string;
}

export default defineWorkflow<MeuSiteInput, unknown>({
  name: "meu-site",
  description: "Cadastro em meu-site.example",
  defaults: { baseUrl: "https://meu-site.example" },

  buildInput(overrides) {
    const { email, password } = fakePerson();
    return { email, password, ...overrides };
  },

  steps: [
    goto("/signup", { waitFor: "form" }),
    fillForm({
      "#email": (ctx) => ctx.input.email,
      "#password": (ctx) => ctx.input.password,
    }),
    submitAndCapture("button[type=submit]", { urlPart: "/api/signup", saveAs: "signup" }),
    waitVisible(".welcome"),
  ],
});
```

2. Registre-o em `src/workflows/index.ts`:

```ts
import localSignup from "./local-signup.js";
import meuSite from "./meu-site.js";

export const registry = new WorkflowRegistry().register(localSignup, meuSite);
```

3. Rode: `npm run workflow -- run meu-site --headed`.

Sem `result`, a saída do workflow é `ctx.state`. Use `src/workflows/local-signup.ts` como modelo completo.

### Steps disponíveis (`src/core/steps.ts`)

Valores aceitam literal ou função `(ctx) => valor` (acesso a `ctx.input`, `ctx.config`, `ctx.state`).

| Step | Descrição |
| --- | --- |
| `goto(url, { waitFor? })` | Navega para URL absoluta ou relativa a `config.baseUrl`; opcionalmente espera um seletor ficar visível. |
| `fillForm({ seletor: valor })` | Preenche campos detectando o tipo (input, select, checkbox, radio); `undefined` é pulado. |
| `click(seletor)` | Clica num elemento. |
| `submitAndCapture(seletor, { urlPart, saveAs? })` | Clica e captura a resposta HTTP não-GET cuja URL contém `urlPart` em `ctx.state[saveAs]` (`{ status, body }`). |
| `waitVisible(seletor, timeout?)` | Espera o elemento ficar visível (padrão 10 s). |
| `extractText(seletor, saveAs)` | Lê o texto do elemento para `ctx.state[saveAs]`. |
| `collectErrors(seletor)` | Coleta mensagens visíveis em `ctx.state.formErrors`. |
| `assert(descrição, predicado)` | Falha se `predicado(ctx)` for falso. |
| `custom(nome, run)` | Passo livre para lógica específica. |
| `optional(step)` | Marca um passo como opcional: a falha é registrada mas não interrompe o workflow. |

## Gravar e replicar (record & replay)

Em vez de escrever o workflow em código, você pode **fazer o fluxo uma vez no navegador** e o projeto grava o que você clicou e digitou, salva em `recordings/<nome>.json` e depois replica sozinho.

### 1. Gravar

```
npm run record -- meu-fluxo --url https://site.example/cadastro
```

Abre o Chromium (CloakBrowser) visível. Faça o fluxo normalmente; o terminal mostra cada passo capturado:

```
● gravando "meu-fluxo" — faça o fluxo no navegador; feche a janela (ou Ctrl+C) para salvar
  + #1 abrir https://site.example/cadastro
  + #2 preencher "E-mail" ← {{email}}
  + #3 preencher "Senha" ← {{password}}
  + #4 clicar "Criar conta"
  + #5 esperar URL https://site.example/bem-vindo
```

- **Feche a janela ou aperte Ctrl+C** para terminar. A gravação também é salva a cada passo, então nada se perde se algo cair.
- **Alt+G** com o cursor num campo abre um menu de **valor aleatório** (nome, sobrenome, nome completo, e-mail, usuário, senha, número). O campo é preenchido na hora e, no replay, **cada execução gera um valor novo**. Escolha com o mouse ou pelo número; Esc fecha.
- **Alt+clique** num elemento marca um *ponto de verificação* ("isto tem que aparecer"), sem clicar nele. Use no final (ex.: na mensagem "Conta criada") para o replay só dar sucesso se o fluxo realmente funcionou.
- O que é gravado: cliques, digitação, selects, checkboxes/radios, Enter/Escape e navegações. Digitação no mesmo campo vira um único passo com o valor final.

### 2. Ver e editar

```
npm run workflow -- show meu-fluxo
npm run workflow -- list            # workflows em código + gravações
```

O JSON é legível e pode ser editado à mão (trocar seletor, remover passo, mudar URL). Cada elemento tem um seletor principal e alternativas (`fallbacks`: id, `name`, label, texto do botão, caminho CSS) testadas em ordem no replay.

### 3. Replicar

```
npm run replay -- meu-fluxo --headed --set password=MinhaSenha --set email=outro@example.com
```

- Cada campo de texto vira uma **variável** `{{nome}}` com o valor que você digitou como padrão; troque com `--set`.
- Campos marcados com **Alt+G** ficam como `{{gen.fullName}}`, `{{gen.email}}`… e recebem um conjunto novo e coerente a cada execução (o e-mail e o usuário derivam do mesmo nome). O resultado do replay mostra os valores usados em `generated` (o relatório em `runs/` oculta a senha). Para fixar um deles: `--set gen.email=teste@meusite.com`. Os e-mails usam o domínio `example.test` por padrão; troque com a variável de ambiente `WORKFLOW_EMAIL_DOMAIN`.
- Você também pode editar o JSON e trocar o valor de qualquer `fill` por `{{gen.<tipo>}}` depois de gravar.
- **Senhas nunca são salvas** no arquivo: viram variável obrigatória (`--set password=...`). "Senha" e "confirmar senha" com o mesmo valor usam a mesma variável.
- `--base-url http://localhost:4000` replica a gravação em outro host (ex.: homologação).
- `--timeout <ms>` muda o tempo de espera por elemento/navegação (padrão 15 s).
- Aceita as mesmas opções de navegador do `run` (`--headed`, `--slow-mo`, `--proxy`…) e gera o mesmo relatório em `runs/`.

### 4. Continuar

**Um replay que falhou** salva um checkpoint (`recordings/<nome>.checkpoint.json`, fora do Git porque guarda cookies). Continue de onde parou:

```
npm run replay -- meu-fluxo --resume --headed
npm run replay -- meu-fluxo --from 7        # ou de um passo específico (número do `show`)
```

O `--resume` restaura a sessão (cookies/localStorage) e recomeça logo depois da última navegação antes da falha — o que estava digitado na página se perde ao reabri-la, então os passos daquela página são refeitos. Se o site mudou, edite o passo quebrado no JSON antes de continuar.

**Uma gravação** pode ser estendida: o projeto reexecuta os passos gravados e volta a gravar a partir do fim.

```
npm run record -- meu-fluxo --append --set password=MinhaSenha
```

Se algum passo antigo quebrar durante o `--append`, a gravação é cortada ali (o original fica em `recordings/<nome>.json.bak`) e você refaz manualmente a partir daquele ponto.

### Contas criadas e chamadas de API

#### Salvar contas automaticamente

Cada replay bem-sucedido salva as credenciais da conta criada em `recordings/<nome>.accounts.jsonl`. Para isso o sistema precisa saber qual campo é o login e qual é a senha — três formas:

1. **Alt+M** durante a gravação: foque no campo e aperte Alt+M → "Login / E-mail" ou "Senha".
2. **Alt+G**: se você usou `gen.email` e `gen.password`, o sistema já sabe.
3. **Nomes comuns**: variáveis chamadas `email`, `username`, `password`, `senha`… são detectadas automaticamente.
4. **No JSON**: edite `accountFields` manualmente:
   ```json
   "accountFields": { "identifier": "email", "password": "password" }
   ```

No final do replay:
```
✔ concluído
  📋 conta salva: maria.costa.b7c1e4@example.test / se••••••••••••
     → recordings/meu-fluxo.accounts.jsonl
```

Para listar todas as contas criadas:
```
npm run workflow -- accounts meu-fluxo
```

#### Capturar valores da página (Alt+S)

Se o site exibe um dado após o cadastro (telefone, código de verificação, ID da conta…), você pode capturá-lo durante a gravação para usar depois numa chamada de API ou salvar junto com a conta.

1. Quando o dado aparece na tela, passe o mouse sobre ele (ou foque o campo) e aperte **Alt+S**.
2. Um mini-formulário pede o nome da variável (ex.: `telefone`, `codigo`, `account_id`).
3. Aperte Enter. O terminal mostra:
   ```
   + #10 ler "Conta criada! ID: 913b626a…" → {{read.account_id}}
       (capturado: {{read.account_id}} = "913b626a-dd49-4e33-a383-8e02d9201bdd")
   ```
4. No JSON, o passo fica como:
   ```json
   { "type": "readValue", "saveAs": "account_id", "selector": "#account-id" }
   ```

O valor capturado fica disponível como `{{read.account_id}}` em qualquer passo seguinte — inclusive em `callApi`:
```json
{ "type": "callApi", "url": "https://api.example/activate/{{read.account_id}}", "method": "POST" }
```

Se a gravação salva contas (`accountFields`), o valor capturado também é guardado junto:
```
npm run workflow -- accounts meu-fluxo
  1. maria@example.test  /  T3ste!...  (04/10/2026)
     captured: { account_id: "913b626a-..." }
```

#### Chamadas de API no replay

Adicione um passo `callApi` no JSON para chamar uma API durante o replay — por exemplo, para verificar que a conta foi criada, pegar um código de ativação ou notificar um sistema externo:

```json
{
  "type": "callApi",
  "method": "POST",
  "url": "https://api.meusite.example/verify",
  "headers": { "Authorization": "Bearer {{apiToken}}" },
  "body": "{\"email\": \"{{gen.email}}\"}",
  "saveAs": "verificacao",
  "expect2xx": true
}
```

- `url`, `headers` e `body` aceitam variáveis `{{...}}` (inclusive `gen.*`).
- `saveAs` (padrão: `apiResponse`) é o nome da resposta no resultado (`{ status, body }`), que aparece no JSON do replay em `api.<nome>`.
- `extract` puxa campos da resposta JSON e transforma em variáveis `{{api.<nome>}}` para usar nos passos seguintes (fill, outro callApi…). Usa caminho com ponto: `"data.sms.code"` lê `response.body.data.sms.code`.
- `expect2xx` (padrão: `true`): se o status não for 2xx, o replay falha nesse passo (e salva checkpoint para continuar depois).
- Passe variáveis extras como `--set apiToken=abc123`.

**Exemplo completo: capturar telefone → pedir SMS → preencher código**

O fluxo mais comum: o site mostra um número de telefone depois do cadastro, você precisa chamar a API de SMS com esse número, pegar o código e preencher no site.

Na gravação, capture o telefone com Alt+S (nome: `telefone`). Depois edite o JSON e adicione:

```json
[
  { "type": "readValue", "saveAs": "telefone", "selector": "#phone-number" },

  { "type": "callApi", "method": "POST",
    "url": "https://api.sms-service.example/receive",
    "body": "{\"phone\": \"{{read.telefone}}\"}",
    "extract": { "codigo": "data.code" },
    "saveAs": "smsResponse" },

  { "type": "fill", "selector": "#verification-code", "value": "{{api.codigo}}" },

  { "type": "click", "selector": "#verify-button" }
]
```

No replay:
```
• #10 ler "Telefone" → {{read.telefone}}
  → {{read.telefone}} = "+55 31 99999-0000"
• #11 chamar API POST https://api.sms-service.example/receive
  → POST https://api.sms-service.example/receive
  HTTP 200
  → {{api.codigo}} = "482917"
• #12 preencher "Código de verificação" ← {{api.codigo}}
  ← "482917"
• #13 clicar "Verificar"
✔ concluído
  📋 conta salva: maria@example.test / se••••••
     captured: { telefone: "+55 31 99999-0000" }
```

Variáveis disponíveis em cada passo:

| Prefixo | Quando é preenchida | Exemplo |
|---------|---------------------|---------|
| `{{email}}` | Na gravação (digitada) ou `--set` | `{{email}}` |
| `{{gen.*}}` | Gerada a cada execução (Alt+G) | `{{gen.email}}`, `{{gen.password}}` |
| `{{read.*}}` | Lida da página no replay (Alt+S) | `{{read.telefone}}` |
| `{{api.*}}` | Extraída da resposta de `callApi` | `{{api.codigo}}` |

### CAPTCHA automático no replay

Se o site exibir um CAPTCHA durante o replay (reCAPTCHA v2, hCaptcha ou Cloudflare Turnstile), o sistema **detecta e resolve sozinho** sem precisar de um passo gravado — você não precisa se preocupar com isso na gravação.

Configure a chave do serviço de resolução:

```
$env:CAPTCHA_SOLVER_API_KEY = "sua-chave-do-2captcha-ou-capsolver"
$env:CAPTCHA_SOLVER_SERVICE = "2captcha"   # ou "capsolver" ou "anticaptcha"
npm run replay -- meu-fluxo --headed
```

O guard verifica antes de cada passo e, se um passo falhar por causa de um CAPTCHA que apareceu (ex.: botão desabilitado pelo widget), resolve e tenta de novo. No final mostra quantos foram resolvidos.

Sem a API key, o replay **para e espera você resolver manualmente** no navegador (precisa de `--headed`). Para desabilitar completamente, passe `--no-captcha`.

### Limitações

- Ações em **iframes** e em **novas abas/pop-ups** não são gravadas (o terminal avisa quando uma aba nova abre).
- Upload de arquivo, arrastar-e-soltar, hover e desenho em canvas não são capturados — adicione à mão com um workflow em código (`custom(...)`).
- Sites que geram ids/classes aleatórios a cada carregamento podem exigir ajustar o seletor no JSON.

### Usar pelo código

```ts
import { loadRecording, recordingToWorkflow, replayRecording, runWorkflow } from "./src/index.js";

const rec = await loadRecording("meu-fluxo");
await replayRecording(rec!, { input: { password: "..." }, browser: { headless: false } });
// ou como workflow comum, para combinar com outros passos:
const wf = recordingToWorkflow(rec!);
```

Arquivos: `src/recorder/inject.ts` (script na página), `builder.ts` (eventos → passos), `recorder.ts` (sessão de gravação), `replay.ts` (gravação → workflow, checkpoint), `store.ts` (arquivos).

## Pool de proxy com rotação do provedor

Cada execução abre um navegador novo conectado ao gateway configurado. O provedor
controla quando o IP de saída troca (por conexão, tempo ou sessão). O projeto não
chama APIs de rotação e não garante IP único por execução. Prefira manter o IP
estável durante um workflow se o provedor oferecer essa opção. Não há fallback
para conexão direta quando o proxy configurado falha.

No PowerShell, antes de executar o workflow:

```powershell
$env:WORKFLOW_PROXY_SERVER = "http://gateway.seu-provedor.com:8080"
$env:WORKFLOW_PROXY_USERNAME = "usuario-fornecido-pelo-provedor"
$env:WORKFLOW_PROXY_PASSWORD = "senha-fornecida-pelo-provedor"
npm run workflow -- run local-signup --base-url https://seu-formulario.example --headed
```

Também é possível passar apenas o gateway com `--proxy http://host:porta`.
Credenciais ficam nas variáveis de ambiente, fora do input e relatório do workflow.
Não publique credenciais no Git. HTTP/HTTPS autenticado é aceito; SOCKS5 autenticado
não é suportado pelo Chromium. Sem configuração, permanece a conexão direta.
