export declare const MAY_BREAK_THIS_MACHINE: string;
export declare const MACHINE_CHECK: string;
export declare const NO_EXEMPTIONS: string;
export declare const BOX_MARKER: string;
export declare const SUDO_ANSWERS: { readonly noPassword: SudoAnswer; readonly needsPassword: SudoAnswer; readonly inconclusive: SudoAnswer; readonly absent: SudoAnswer };
export declare const SUDO_PROBE_LIMITS: SudoProbeLimits;

export type SudoAnswer = "no-password" | "needs-password" | "inconclusive" | "absent";

export interface SudoProbeLimits {
  readonly answerWithinMs: number;
  readonly killAfterMs: number;
}

export interface TestMachineFacts {
  readonly root: boolean;
  readonly sudo: SudoAnswer;
  readonly tailscale: string | null;
  readonly box: boolean;
  readonly githubActions: boolean;
  readonly override: boolean;
  readonly noExemptions: boolean;
}

export declare function isBoxImageRecord(marker: string, expectedOwner?: number): boolean;
export declare function readTestMachineFacts(options?: { env?: Readonly<Record<string, string | undefined>>; marker?: string; sudoLimits?: SudoProbeLimits }): Promise<TestMachineFacts>;
export declare function testMachineRefusal(facts: TestMachineFacts): string | null;
export declare function refusalForThisMachine(env?: Readonly<Record<string, string | undefined>>): Promise<string | null>;
export declare function refuseRiskyTestMachine(): Promise<void>;
