// Ambient types for the browser bridge (window.mecode, provided by the Electron preload or src/renderer/bridge.js).
type MecodeEnvelope<T> = { ok: boolean; value?: T; error?: { code: string; message: string; details?: unknown } }; // tsconfig is non-strict: a discriminated union would not narrow
type AcceptedSolution = {
  schemaVersion: 1;
  key: string;
  language: 'python' | 'javascript' | 'cpp' | 'c';
  contentHash: string; // catalog problem hash (tests+comparison) the submission was judged against
  sourceHash: string; // SHA-256 of the exact UTF-8 submitted source
  source: string;
  acceptedAt: string;
};
type SolutionLoadRequest = { key: string; language: string };
type SolutionLoadResponse = { solution: AcceptedSolution | null; stale: boolean };
type SolutionPersistence = 'saved' | 'failed' | 'n/a';
interface Window {
  mecode: Record<string, any> & { solution?: { load(a: SolutionLoadRequest): Promise<MecodeEnvelope<SolutionLoadResponse>> } };
}
