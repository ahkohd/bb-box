import { PRODUCT } from "../brand.ts";
import type { DoctorCheck } from "../backends/types.ts";

export type ProjectsOf = (backendId: string) => readonly string[];

export type Audience = { readonly of: "thread"; readonly projectId: string | null } | { readonly of: "everyone" };

export const EVERYONE: Audience = { of: "everyone" };

export function threadAudience(projectId: string | null): Audience {
  return { of: "thread", projectId };
}

export function isShared(projects: readonly string[]): boolean {
  return projects.length === 0;
}

export function servesAudience(projects: readonly string[], audience: Audience): boolean {
  if (audience.of === "everyone" || isShared(projects)) return true;
  return audience.projectId !== null && projects.includes(audience.projectId);
}

function reservedForAudience(projects: readonly string[], audience: Audience): boolean {
  return audience.of === "thread" && !isShared(projects) && servesAudience(projects, audience);
}

export interface Tiers<T> {
  readonly reserved: readonly T[];
  readonly shared: readonly T[];
}

export function tiersFor<T extends { readonly backend: { readonly id: string } }>(offers: readonly T[], projectsOf: ProjectsOf, audience: Audience): Tiers<T> {
  const served = offers.filter((offer) => servesAudience(projectsOf(offer.backend.id), audience));
  return {
    reserved: served.filter((offer) => reservedForAudience(projectsOf(offer.backend.id), audience)),
    shared: served.filter((offer) => !reservedForAudience(projectsOf(offer.backend.id), audience)),
  };
}

export function inAcquireOrder<T extends { readonly backend: { readonly id: string } }>(offers: readonly T[], projectsOf: ProjectsOf, audience: Audience): T[] {
  const tiers = tiersFor(offers, projectsOf, audience);
  return [...tiers.reserved, ...tiers.shared];
}

export const NONE_SERVES_THREAD = "Every backend here is kept for certain projects, and none for this thread's, so it has no kinds to acquire. Ask the user: they choose each backend's projects in BB Box's settings.";

export function keptForOthersWords(name: string, audience: Audience, cannot = "it cannot make this box"): string {
  const thread = audience.of === "thread" && audience.projectId === null ? "this thread has no project" : "this thread's project is not one of them";
  return `${name} is kept for certain projects, and ${thread}, so ${cannot}.`;
}

export interface KeptBackend {
  readonly id: string;
  readonly label: string;
  readonly projects: readonly string[];
}

/** For the doctor: each backend kept for projects, the ones it serves by name, and a warning when none is still in BB. Null `existing` when BB did not say. */
export function reservedChecks(backends: readonly KeptBackend[], existing: ReadonlyMap<string, string> | null): DoctorCheck[] {
  return backends
    .filter((backend) => !isShared(backend.projects))
    .map((backend): DoctorCheck => {
      const id = `projects.${backend.id}` as const;
      const name = `Projects of ${backend.label}`;
      if (!existing) return { id, name, status: "skipped", detail: `Kept for ${countWords(backend.projects.length)}. BB did not say which projects it has, so ${PRODUCT} could not check they still exist.`, fix: null };
      const served = backend.projects.filter((project) => existing.has(project)).map((project) => existing.get(project)!);
      const gone = backend.projects.length - served.length;
      if (!served.length) {
        return {
          id,
          name,
          status: "warn",
          detail: `Kept for ${countWords(gone)} that ${gone === 1 ? "is" : "are"} no longer in BB, so it serves no project and no thread can use it.`,
          fix: `Choose its projects again in ${PRODUCT}'s settings, or let every project use it: bb box backend set ${backend.id} --projects ""`,
        };
      }
      const left = gone ? ` ${countWords(gone, "other")} it was kept for ${gone === 1 ? "is" : "are"} no longer in BB.` : "";
      return { id, name, status: "ok", detail: `Kept for ${served.join(", ")}: only their threads see it.${left}`, fix: null };
    });
}

function countWords(count: number, other = ""): string {
  const what = `${other ? `${other} ` : ""}${count === 1 ? "project" : "projects"}`;
  return `${count} ${what}`;
}
