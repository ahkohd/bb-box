export declare const MAY_BREAK_THIS_MACHINE: string;
export declare const MACHINE_CHECK: string;
export declare const NO_EXEMPTIONS: string;
export declare const BOX_MARKER: string;

export interface TestMachineFacts {
  readonly root: boolean;
  readonly passwordlessSudo: boolean;
  readonly tailscale: string | null;
  readonly box: boolean;
  readonly githubActions: boolean;
  readonly override: boolean;
  readonly noExemptions: boolean;
}

export declare function readTestMachineFacts(options?: { env?: Readonly<Record<string, string | undefined>>; marker?: string }): TestMachineFacts;
export declare function testMachineRefusal(facts: TestMachineFacts): string | null;
export declare function refusalForThisMachine(env?: Readonly<Record<string, string | undefined>>): string | null;
export declare function refuseRiskyTestMachine(): void;
