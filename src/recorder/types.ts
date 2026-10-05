/**
 * Formato de uma gravação. É JSON puro (sem funções) para poder ser salvo em
 * `recordings/<nome>.json`, editado à mão e reexecutado depois.
 *
 * Valores de campos podem conter variáveis `{{nome}}`, resolvidas na hora do
 * replay a partir de `variables` (padrões gravados) e de `--set nome=valor`.
 */

/** Seletor principal + alternativas, testadas em ordem no replay. */
export interface Target {
  selector: string;
  fallbacks?: string[];
  /** Descrição legível do elemento (texto, label…), só para logs. */
  hint?: string;
}

export type RecordedStep =
  | { type: "goto"; url: string }
  | ({ type: "click" } & Target)
  | ({ type: "fill"; value: string } & Target)
  | ({ type: "select"; value: string } & Target)
  | ({ type: "check"; checked: boolean } & Target)
  | ({ type: "press"; key: string } & Target)
  /** Espera a página chegar numa URL (navegação causada pelo passo anterior). */
  | { type: "waitForUrl"; url: string }
  /** Ponto de verificação marcado com Alt+clique durante a gravação. */
  | ({ type: "waitVisible" } & Target)
  /**
   * Lê o texto de um elemento da página e salva como variável `{{read.<nome>}}`.
   * Útil para capturar dados que o site exibe (telefone, código, ID…) e usar
   * em passos seguintes (`callApi`, outra `fill`, ou salvar na conta).
   * Marcado com Alt+S durante a gravação.
   */
  | ({ type: "readValue"; saveAs: string } & Target)
  /** Chamada HTTP a uma API: espera a resposta e salva em `ctx.state[saveAs]`. */
  | {
      type: "callApi";
      /** URL da API (aceita `{{variáveis}}`). */
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      /** Headers (cada valor aceita `{{variáveis}}`). */
      headers?: Record<string, string>;
      /** Corpo da requisição (aceita `{{variáveis}}`). */
      body?: string;
      /** Nome em `ctx.state` onde a resposta é salva (`{ status, body }`). */
      saveAs?: string;
      /** Se true, falha quando o status não é 2xx. Padrão: true. */
      expect2xx?: boolean;
      /**
       * Extrai campos da resposta JSON e salva como variáveis `{{api.<nome>}}`,
       * prontas para usar em passos seguintes (fill, outro callApi…).
       *
       * Chave = nome da variável (vira `{{api.<chave>}}`).
       * Valor = caminho no JSON da resposta (ex.: `"code"`, `"data.sms.code"`,
       *         `"items.0.token"`).
       *
       * Exemplo: `{ "codigo": "data.code" }` → `{{api.codigo}}` no próximo fill.
       */
      extract?: Record<string, string>;
    }
  /**
   * Consulta uma API repetidamente até todos os campos de `extract` existirem.
   * Útil para esperar resultados assíncronos, como um OTP de um ambiente de
   * testes autorizado, sem fixar o projeto a um provedor específico.
   */
  | {
      type: "waitApi";
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      headers?: Record<string, string>;
      body?: string;
      /** Nome em `ctx.state` onde a última resposta é salva. */
      saveAs?: string;
      /** Exige resposta 2xx para considerá-la pronta. Padrão: true. */
      expect2xx?: boolean;
      /** Campos que devem aparecer; viram variáveis `{{api.<nome>}}`. */
      extract: Record<string, string>;
      /** Intervalo entre consultas. Padrão: 5000 ms; mínimo: 500 ms. */
      intervalMs?: number;
      /** Tempo total de espera. Padrão: 120000 ms. */
      timeoutMs?: number;
    };

export interface Recording {
  version: 1;
  name: string;
  description: string;
  startUrl: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Variáveis usadas em `{{...}}`. `null` = sem valor salvo (ex.: senhas):
   * precisa vir de `--set` no replay.
   */
  variables: Record<string, string | null>;
  /**
   * Mapeamento de papel → variável que identifica a conta criada.
   * Definido na gravação (Alt+M) ou auto-detectado de variáveis `gen.*`.
   *
   * Exemplo: `{ identifier: "email", password: "password" }`
   * — o replay salva o par login/senha usado em `recordings/<nome>.accounts.jsonl`.
   */
  accountFields?: {
    identifier?: string;
    password?: string;
  };
  steps: RecordedStep[];
}

/** Estado salvo quando um replay falha, para continuar depois com `--resume`. */
export interface Checkpoint {
  recording: string;
  /** Índice (0-based) do passo que falhou. */
  failedStep: number;
  /**
   * Índice (0-based) por onde o replay recomeça: o primeiro passo depois da
   * última navegação antes da falha. O que foi digitado na página se perde ao
   * reabri-la, então os passos dela são refeitos; a sessão (cookies) não.
   */
  nextStep: number;
  /** URL aberta antes de `nextStep` (a da última navegação). */
  url: string;
  /** Cookies + localStorage do navegador (formato `storageState` do Playwright). */
  storageState: unknown;
  error?: string;
  savedAt: string;
}

/** Evento bruto enviado pelo script injetado na página (`id` único, `at` = Date.now() na página). */
export type PageEvent = { id?: string; at?: number } & (
  /** Alt+Z / botão Desfazer: remove a última etapa gravada. */
  | { kind: "undo" }
  | ({ kind: "click"; alt: boolean } & Target)
  | ({ kind: "input"; value: string; inputType: string; field: string } & Target)
  | ({ kind: "select"; value: string; field: string } & Target)
  | ({ kind: "check"; checked: boolean } & Target)
  | ({ kind: "key"; key: string } & Target)
  /** Alt+G: campo marcado para receber um valor aleatório a cada execução. */
  | ({ kind: "generate"; gen: string; inputType: string } & Target)
  /** Alt+M: marcar campo como identificador ou senha da conta. */
  | ({ kind: "markAccount"; role: "identifier" | "password" } & Target)
  /** Alt+S: capturar o texto de um elemento para usar depois. */
  | ({ kind: "captureValue"; saveAs: string; value: string } & Target)
);
