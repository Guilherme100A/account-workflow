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
E2E=1 npx vitest run tests/e2e.test.ts          # bash
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
