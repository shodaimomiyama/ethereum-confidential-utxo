export function createEnvironmentManifest(artifact: unknown, source: string, config: string): Record<string, string>;
export function verifyEnvironmentArtifact(artifact: unknown, manifest: unknown, source: string, config: string): Record<string, string>;
export function verifyGeneratedEnvironmentFixture(artifact: unknown, generated: unknown, source: string, config: string): Record<string, string>;
