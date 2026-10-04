import type { WorkflowDefinition } from "./types.js";

/** Valida a definição em tempo de carga e preserva os tipos genéricos. */
export function defineWorkflow<I, O>(def: WorkflowDefinition<I, O>): WorkflowDefinition<I, O> {
  if (!def.name || !def.description) throw new Error("Workflow inválido: name/description ausentes");
  if (!def.defaults?.baseUrl) throw new Error(`Workflow "${def.name}": defaults.baseUrl ausente`);
  if (!def.steps.length || def.steps.some((s) => typeof s?.run !== "function")) {
    throw new Error(`Workflow "${def.name}": steps deve ser uma lista não vazia de { name, run }`);
  }
  return Object.freeze(def);
}

export class WorkflowRegistry {
  private readonly items = new Map<string, WorkflowDefinition<any, any>>();

  register(...workflows: WorkflowDefinition<any, any>[]): this {
    for (const wf of workflows) {
      if (this.items.has(wf.name)) throw new Error(`Workflow duplicado: ${wf.name}`);
      this.items.set(wf.name, wf);
    }
    return this;
  }

  get(name: string): WorkflowDefinition<any, any> {
    const wf = this.items.get(name);
    if (!wf) throw new Error(`Workflow "${name}" não encontrado. Disponíveis: ${this.names().join(", ")}`);
    return wf;
  }

  names(): string[] {
    return [...this.items.keys()];
  }

  list(): WorkflowDefinition<any, any>[] {
    return [...this.items.values()];
  }
}
