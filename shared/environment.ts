export type EnvironmentState =
  | "configured"
  | "preparing"
  | "waiting"
  | "ready"
  | "uncertain";
export type ProjectEnvironment = {
  projectId: string;
  slug: string;
  repository: string;
  branch: "preview";
  profile: "static" | "application";
  previewUrl: string;
  productionUrl: string;
  state: EnvironmentState;
  step: string;
  detail: string;
  dataReady: boolean;
  ciState: string;
  commit: string;
  deployedCommit: string;
  version: number;
  updatedAt: string;
};
export type EnvironmentResources = {
  application: string;
  dataProject: string;
  deployment: string;
};
export type EnvironmentRecord = ProjectEnvironment & {
  resources: EnvironmentResources;
  lease: string;
};
export function publicEnvironment(
  record: EnvironmentRecord,
): ProjectEnvironment {
  const { resources: _resources, lease: _lease, ...result } = record;
  return result;
}
