export declare const ROOT_RUNNERS: readonly string[];
export declare const HOST_CHANGING_COMMANDS: readonly string[];
export declare const PATH_GUARDED_COMMANDS: readonly string[];
export declare const PRIVILEGED_COMMANDS: readonly string[];
export declare const GUARD_FOLDER_PREFIX: string;
export declare const SYSTEM_PATH: string;
export declare const READ_OR_CHANGE_COMMANDS: Readonly<Record<string, readonly string[]>>;
export declare const OWNED_FOLDERS_VARIABLE: string;

export interface HostToolStandIns {
  readonly dir: string;
  ran(): string[];
}

export declare function testMadeRoots(): string[];
export declare function isTestMade(path: string): boolean;
export declare function firstOnPath(name: string, path: string): string | null;
export declare function realHostToolsReached(path: string, madeByTests?: (path: string) => boolean): string[];
export declare function refusalForRealHostTools(fake: string, path: string, madeByTests?: (path: string) => boolean): string | null;
export declare function privilegedToolsOn(path: string): string[];
export declare function runAsRootUnderHostStubs(root: string, path?: string): string;
export declare function ownedFoldersEnv(owned: readonly string[], temp: string): Record<string, string>;
export declare function hostStubsIn(root: string, path?: string): string;
export declare function pathWithHostStubs(root: string, testBins: readonly string[], rest: string | undefined): string;
export declare function hostCommandsRecorded(root: string): string[];
export declare function hostStubsRootForThisProcess(): string;
export declare function pathRefusingRealHostTools(fake: string, path: string): string;
export declare function recordingStandInsForHostTools(dir: string, names: readonly string[]): HostToolStandIns;
export declare function withHostToolsFirstOnPath<T>(standIns: HostToolStandIns, run: () => Promise<T>): Promise<T>;
