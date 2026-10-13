import { buildDesignContract, canonicalJson } from "../shared/design.ts";
import type { Workspace } from "../shared/domain.ts";
import { hash } from "./store.ts";
export function designContract(workspace: Workspace) {
  const contract = buildDesignContract(workspace);
  return { ...contract, checksum: hash(canonicalJson(contract)) };
}
