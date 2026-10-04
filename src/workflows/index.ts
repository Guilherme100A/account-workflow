/**
 * Registro central de workflows. Para adicionar um novo:
 *   1. crie src/workflows/<nome>.ts exportando `defineWorkflow({...})` por padrão
 *   2. importe-o abaixo e inclua em `register(...)`
 */

import { WorkflowRegistry } from "../core/registry.js";
import localSignup from "./local-signup.js";

export const registry = new WorkflowRegistry().register(localSignup);
